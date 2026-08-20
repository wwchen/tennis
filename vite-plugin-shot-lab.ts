import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Serves the `tennisproc` output tree to the review app in dev.
 *
 * Dev only, by design: the app must keep working without it (see
 * `loadEtlClips`), so `vite build` output never depends on this route.
 */

const OUT_ROOT = () => resolve(process.env.SHOT_LAB_OUT ?? 'out');

/** The one filename the app is allowed to write. */
const WRITABLE = 'user-edit.json';

/**
 * The only shape a write target may have: `<session>/swings/swing_NNN`.
 * Without this the filename is constrained but the directory is not, and
 * `PUT /api/swings/IMG_0304/work/user-edit` writes outside a swing.
 */
const SWING_DIR = /^[^/]+\/swings\/swing_\d+$/;

/** `schema.ETL_OWNED`: blocks a user edit may never rewrite. */
const ETL_OWNED = ['source', 'trim', 'crop', 'detection', 'measurements'] as const;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

type Json = Record<string, unknown>;

const STAGES = new Set(['setup', 'contact', 'finish', 'other']);
const STROKES = new Set(['forehand', 'backhand', 'volley', 'serve', 'overhead', 'other']);
const VERDICTS = new Set(['valid', 'false_positive', 'duplicate', 'unclear']);
const PLAYER_SLOTS = new Set(['left', 'right', 'near', 'far']);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Runtime guard for the document accepted by the write-only dev endpoint. */
function isWritableSwingDoc(value: unknown): value is Json {
  if (!isObject(value) || value.schema !== 'tennis.swing/1' || typeof value.id !== 'string') {
    return false;
  }
  for (const block of ['source', 'trim', 'crop', 'detection'] as const) {
    if (!isObject(value[block])) return false;
  }
  if (value.measurements !== null && !isObject(value.measurements)) return false;

  const labels = value.labels;
  if (!isObject(labels)) return false;
  if (
    !(labels.player_slot === null ||
      (typeof labels.player_slot === 'string' && PLAYER_SLOTS.has(labels.player_slot)))
  )
    return false;
  if (!isNullableString(labels.player_name)) return false;
  if (
    !(labels.stroke === null ||
      (typeof labels.stroke === 'string' && STROKES.has(labels.stroke)))
  )
    return false;
  const quality = labels.quality;
  if (
    !(
      quality === null ||
      (typeof quality === 'number' &&
        Number.isInteger(quality) &&
        quality >= 1 &&
        quality <= 5)
    )
  )
    return false;
  if (
    !(labels.verdict === null ||
      (typeof labels.verdict === 'string' && VERDICTS.has(labels.verdict)))
  )
    return false;
  if (!Array.isArray(labels.tags) || !labels.tags.every((tag) => typeof tag === 'string')) return false;
  if (!isNullableString(labels.notes)) return false;

  if (!Array.isArray(value.frames) || value.frames.length === 0) return false;
  if (!value.frames.every((frame) => {
    if (!isObject(frame)) return false;
    return (
      isFiniteNumber(frame.source_ms) &&
      isFiniteNumber(frame.clip_ms) &&
      isFiniteNumber(frame.offset_contact_ms) &&
      typeof frame.file === 'string' &&
      (frame.pose_score === null || isFiniteNumber(frame.pose_score)) &&
      (frame.stage === null || (typeof frame.stage === 'string' && STAGES.has(frame.stage)))
    );
  })) return false;

  const edit = value.edit;
  return (
    isObject(edit) &&
    typeof edit.by === 'string' &&
    typeof edit.at === 'string' &&
    (edit.against === undefined || typeof edit.against === 'string') &&
    typeof edit.reviewed === 'boolean'
  );
}

/**
 * Resolves a request path inside the output root, or returns null.
 *
 * Resolves symlinks before the containment check so that a symlink inside the
 * tree pointing outside cannot escape the sandbox. Returns null for paths that
 * do not exist on disk.
 */
function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  if (!existsSync(full)) return null;

  try {
    const realRoot = realpathSync(root);
    const realFull = realpathSync(full);
    return realFull === realRoot || realFull.startsWith(realRoot + sep) ? realFull : null;
  } catch {
    return null;
  }
}

/**
 * Marker key for a numeric literal lifted out of the raw JSON text.
 *
 * A NUL is not legal unescaped inside a JSON string, and `tennisproc` never
 * emits one escaped either, so an object carrying exactly this one key is
 * always one this module put there.
 */
const NUM_BOX = String.fromCharCode(0) + 'n';

/** Sticky: only matches a number literal starting exactly at `lastIndex`. */
const NUMBER_AT = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/y;

/**
 * Rewrites every numeric literal outside a string as `{"\0n":"<literal>"}`.
 *
 * The literal text is the only place the int/float distinction survives:
 * `JSON.parse` turns both `1` and `1.0` into the same value, and
 * `JSON.stringify` writes both back as `1`.
 */
function boxNumberLiterals(raw: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;

  while (i < raw.length) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') {
        out.push(raw.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER_AT.lastIndex = i;
      const match = NUMBER_AT.exec(raw);
      if (match !== null) {
        out.push(JSON.stringify({ [NUM_BOX]: match[0] }));
        i += match[0].length;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }

  return out.join('');
}

/** The boxed literal inside `value`, or null if `value` is not a box. */
function boxedLiteral(value: Json): string | null {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== NUM_BOX) return null;
  const literal = value[NUM_BOX];
  return typeof literal === 'string' ? literal : null;
}

/**
 * A numeric literal as Python's `json.dumps` would re-emit it.
 *
 * `json.dumps` writes a float with `repr()`, so an integral float keeps its
 * `.0` where an int does not. `metadata.json` is written by that same
 * `json.dump`, so every float literal in it is already `repr()` output and
 * passing it through unchanged is exact.
 *
 * The normalisation below only matters for a hand-edited file, where `1.50`
 * must still hash as `1.5`. It is skipped in the ranges where Python and
 * JavaScript disagree about when to switch to exponential notation
 * (`repr(1e16)` is `1e+16`, `String(1e16)` is `10000000000000000`); there the
 * literal is the better answer.
 */
function pythonNumber(literal: string): string {
  // An int: Python prints the digits, and the literal keeps full precision for
  // values Python can hold exactly but a JS number cannot.
  if (!/[.eE]/.test(literal)) return literal;

  const n = Number(literal);
  const js = String(n);
  const abs = Math.abs(n);
  if (!Number.isFinite(n) || js.includes('e') || abs >= 1e16 || (n !== 0 && abs < 1e-4)) {
    return literal;
  }
  if (Number.isInteger(n)) return Object.is(n, -0) ? '-0.0' : `${js}.0`;
  return js;
}

/**
 * A string as `json.dumps` writes it, which defaults to `ensure_ascii=True`.
 *
 * `JSON.stringify` escapes the control characters and the quote/backslash pair
 * identically; what it does not do is escape everything above U+007E, so any
 * non-ASCII character in a filename or a reviewer's note has to be escaped
 * here or the two hashes diverge on that instead.
 */
const NON_ASCII = new RegExp('[\\u007f-\\uffff]', 'g');

const pythonString = (s: string): string =>
  JSON.stringify(s).replace(
    NON_ASCII,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

/** `json.dumps(value, sort_keys=True, separators=(",", ":"))`. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return pythonString(value);
  // Only reachable for a number that was never boxed, i.e. never came from
  // raw JSON text.
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (!isObject(value)) return 'null';

  const literal = boxedLiteral(value);
  if (literal !== null) return pythonNumber(literal);

  const body = Object.keys(value)
    .sort()
    .map((key) => pythonString(key) + ':' + canonicalJson(value[key]))
    .join(',');
  return '{' + body + '}';
}

/**
 * Mirrors `schema.doc_hash`: sorted-key JSON of everything but `edit`.
 *
 * Takes the raw file text rather than a parsed document because Python's
 * number formatting cannot be recovered after `JSON.parse`. Four of the 42
 * swings in the sample session carry an integral float
 * (`detection.contact_offset` is `-1.0`, `measurements.wrist_peak_speed` is
 * `40.0`); hashing the parsed object writes those as `-1` and `40` and the two
 * implementations disagree, which shows up as a false "stale review" warning.
 */
function docHash(raw: string): string {
  const boxed = JSON.parse(boxNumberLiterals(raw)) as Json;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { edit: _edit, ...rest } = boxed;
  const blob = canonicalJson(rest);
  return 'sha256:' + createHash('sha256').update(blob).digest('hex').slice(0, 16);
}

/**
 * Mirrors `schema.overlay`: merges a human's `user-edit.json` onto ETL output.
 *
 * Kept here rather than in `src/domain/` because the read adapter is pure and
 * this is part of reading files. The rules, and why they are these rules, are
 * documented on `overlay()` in `tennisproc/schema.py`:
 *
 *   - `labels`: field by field, a non-null value in the edit wins
 *     (`tags`: non-empty wins).
 *   - `frames`: joined on `source_ms`, never array position, so re-extracting
 *     at a different fps cannot move a human's stage onto another moment. A
 *     non-null `stage` wins; a frame whose `source_ms` is not in the metadata
 *     is dropped.
 *   - `source`/`trim`/`crop`/`detection`/`measurements`: metadata always wins.
 *   - `edit`: the edit's own block is carried through, which is what makes
 *     `adaptSwing` report the clip as triaged.
 */
function overlayEdit(metadata: Json, userEdit: unknown): Json {
  if (!isObject(userEdit)) return metadata;

  const merged = structuredClone(metadata);

  if (!isObject(merged.labels)) merged.labels = {};
  const dstLabels = merged.labels as Json;
  const srcLabels = isObject(userEdit.labels) ? userEdit.labels : {};
  for (const [key, value] of Object.entries(srcLabels)) {
    if (key === 'tags') {
      if (Array.isArray(value) && value.length > 0) dstLabels.tags = structuredClone(value);
    } else if (value !== null && value !== undefined) {
      dstLabels[key] = structuredClone(value);
    }
  }

  const editsByMs = new Map<number, Json>();
  const editFrames: unknown[] = Array.isArray(userEdit.frames) ? userEdit.frames : [];
  for (const frame of editFrames) {
    if (isObject(frame) && typeof frame.source_ms === 'number') {
      editsByMs.set(frame.source_ms, frame);
    }
  }

  const mergedFrames: unknown[] = Array.isArray(merged.frames) ? merged.frames : [];
  for (const frame of mergedFrames) {
    if (!isObject(frame) || typeof frame.source_ms !== 'number') continue;
    const edited = editsByMs.get(frame.source_ms);
    if (edited !== undefined && edited.stage !== null && edited.stage !== undefined) {
      frame.stage = edited.stage;
    }
  }

  // `merged` started as a copy of the metadata and nothing above touches an
  // ETL-owned block, so this is already true. Restated so it stays true if the
  // label loop ever grows, and so a hostile edit claiming a different `source`
  // provably cannot land.
  for (const block of ETL_OWNED) {
    if (block in metadata) merged[block] = structuredClone(metadata[block]);
  }

  if (isObject(userEdit.edit)) merged.edit = structuredClone(userEdit.edit);

  return merged;
}

/** First directory under `out/` that has a `swings/` child. */
function findSession(root: string): string | null {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort()) {
    if (existsSync(join(root, name, 'swings'))) return name;
  }
  return null;
}

/** Mirrors `session.read_json`: unreadable or malformed reads as absent. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function readSession(root: string) {
  const session = findSession(root);
  if (session === null) return null;

  const swingsDir = join(root, session, 'swings');
  const swings = readdirSync(swingsDir)
    .filter((d) => d.startsWith('swing_'))
    .sort()
    .flatMap((dir) => {
      const metaPath = join(swingsDir, dir, 'metadata.json');
      if (!existsSync(metaPath)) return [];
      const raw = readFileSync(metaPath, 'utf-8');
      const metadata = JSON.parse(raw) as Json;
      // The hash stays that of the metadata alone. `edit.against` records
      // which ETL output was reviewed, so hashing the merged document would
      // make it self-referential and every review would read as stale.
      const hash = docHash(raw);
      const userEdit = readJson(join(swingsDir, dir, WRITABLE));
      const doc = overlayEdit(metadata, userEdit);
      // The unmerged edit goes back too. `overlayEdit` drops frames whose
      // `source_ms` metadata does not know about — matching `overlay()`, which
      // does that on purpose so an `--fps` change is recoverable rather than
      // destructive. Those entries exist only here, so write-back needs this to
      // avoid erasing them from disk on a bare load.
      const edit = isObject(userEdit) ? userEdit : null;
      return [{ dir: `swings/${dir}`, hash, doc, edit }];
    });

  return { session, swings };
}

/**
 * Where a `PUT .../user-edit` may write, or the status to answer with.
 *
 * Separate from the route so both refusals are directly testable; a dev-server
 * fixture would have to be stood up to reach them otherwise, and these are the
 * two checks that keep the route away from `metadata.json`.
 */
function resolveWriteTarget(
  root: string,
  rel: string,
): { target: string } | { status: 403 | 404 } {
  const suffix = '/user-edit';
  if (!rel.endsWith(suffix)) return { status: 404 };

  // The filename alone is not enough: without this, `IMG_0304/work/user-edit`
  // and `IMG_0304/user-edit` both resolve and write outside a swing directory.
  const relDir = rel.slice(0, -suffix.length);
  if (!SWING_DIR.test(relDir)) return { status: 404 };

  const dir = safeJoin(root, relDir);
  if (dir === null || !statSync(dir).isDirectory()) return { status: 404 };

  // `safeJoin` realpaths the directory, but a write follows a symlink at the
  // final component, so a `user-edit.json -> metadata.json` link planted in
  // the tree would let this route overwrite ETL output. A target that does not
  // exist yet is the normal first write.
  const target = join(dir, WRITABLE);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    return { status: 403 };
  }

  return { target };
}

/** Writes without following a final symlink or accepting a hard-linked target. */
function writeUserEdit(target: string, data: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const fd = openSync(target, flags, 0o600);
  try {
    if (fstatSync(fd).nlink !== 1) throw new Error('refusing to write a multiply-linked file');
    writeSync(fd, data, undefined, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export default function shotLab(): Plugin {
  return {
    name: 'shot-lab-etl',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/session', (_req, res) => {
        try {
          const payload = readSession(OUT_ROOT());
          if (payload === null) {
            res.statusCode = 404;
            res.end('{"error":"no session"}');
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        } catch {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"error":"corrupt metadata"}');
        }
      });

      server.middlewares.use('/api/media', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const full = safeJoin(OUT_ROOT(), rel);
        if (full === null || !existsSync(full) || !statSync(full).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', MIME[extname(full).toLowerCase()] ?? 'application/octet-stream');
        res.end(readFileSync(full));
      });

      server.middlewares.use('/api/swings', (req, res) => {
        if (req.method !== 'PUT') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // `/<session>/swings/swing_NNN/user-edit`
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const resolved = resolveWriteTarget(OUT_ROOT(), rel);
        if (!('target' in resolved)) {
          res.statusCode = resolved.status;
          res.end(
            resolved.status === 403 ? '{"error":"refusing to write through a symlink"}' : undefined,
          );
          return;
        }
        const { target } = resolved;

        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const doc = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
            if (!isWritableSwingDoc(doc)) {
              res.statusCode = 400;
              res.end('{"error":"invalid swing document"}');
              return;
            }
            writeUserEdit(target, JSON.stringify(doc, null, 1) + '\n');
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end('{"error":"bad document"}');
          }
        });
      });
    },
  };
}

export {
  docHash,
  isWritableSwingDoc,
  overlayEdit,
  readSession,
  resolveWriteTarget,
  safeJoin,
  WRITABLE,
};
