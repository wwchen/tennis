import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Plugin, ViteDevServer } from 'vite';
import { clipExportFileName } from './src/components/clip-export';
import type { ObjectsDoc } from './src/components/object-overlay';
import { parseObjectsJsonl } from './src/components/object-overlay';
import type { BallCandidatesDoc, BallLabelsDoc } from './src/components/ball-labels';
import { parseBallCandidates, parseBallLabels } from './src/components/ball-labels';

/**
 * Serves the `tennisproc` output tree to the review app in dev.
 *
 * Dev only, by design: the app must keep working without it (see
 * `loadEtlClips`), so `vite build` output never depends on this route.
 */

const OUT_ROOT = () => resolve(process.env.SHOT_LAB_OUT ?? 'out');

/** The one filename the app is allowed to write inside a SWING directory. */
const WRITABLE = 'user-edit.json';

/**
 * The one filename the app is allowed to write inside a SESSION directory.
 *
 * Session-level, and deliberately not a swing-level file: it is keyed by source
 * timestamp precisely so that re-running detection — which renumbers every
 * `swings/swing_NNN` — cannot orphan it. Putting it under a swing would undo
 * that in the filesystem while the keys still claimed otherwise.
 */
const BALL_LABELS = 'ball-labels.json';

/**
 * The windowed, native-rate ball candidates for a session.
 *
 * Fixed here for `OBJECTS`' reason: the name is joined onto a path and only
 * `scripts/detect_ball_candidates.py` has ever written it. A DIFFERENT file from
 * `OBJECTS` above, which is a uniform 10fps sample of the whole video for the
 * playback overlay — this one is 60fps and covers contact ±500ms of a sample of
 * swings, because confirming a detection is only possible at the rate the ball
 * was actually filmed at.
 */
const BALL_CANDIDATES = join('work', 'ball-candidates.jsonl.gz');

/**
 * The only shape a write target may have: `<session>/swings/swing_NNN`.
 * Without this the filename is constrained but the directory is not, and
 * `PUT /api/swings/IMG_0304/work/user-edit` writes outside a swing.
 */
const SWING_DIR = /^[^/]+\/swings\/swing_\d+$/;

/**
 * The session's full-length playable video, the one `/api/clip` cuts from.
 *
 * Hard-coded rather than read from `metadata.json`'s `proxy.file`: that name
 * comes out of a file on disk and would then be joined onto a path, and there is
 * no reason to widen this route's attack surface for a filename `transcode.py`
 * has only ever written one value of.
 */
const PROXY = 'source.mp4';

/**
 * The per-frame object detections for a session, relative to its directory.
 *
 * Fixed here rather than read off a document, for `PROXY`'s reason: the name is
 * joined onto a path, and `scripts/detect_objects.py` has only ever been
 * pointed at this one. Served DECOMPRESSED — a browser can be handed a gzip
 * stream, but then every reader of the route needs `DecompressionStream` and a
 * JSONL splitter, and `gunzipSync` on a few megabytes costs a dev server
 * nothing.
 */
const OBJECTS = join('work', 'objects.jsonl.gz');

/**
 * The longest cut `/api/clip` will make, in ms.
 *
 * A swing window is 3.5s and the widest pad the UI offers is 4s a side, so 12s
 * is the real ceiling and this is an order of magnitude of headroom. It exists
 * because the cut is a synchronous re-encode: without a bound, `?end=99999999`
 * asks a dev server to spend eight minutes of CPU on one request.
 */
const MAX_CLIP_MS = 120_000;

/** The widest pad accepted, in seconds. The UI's own maximum is 4. */
const MAX_PAD_S = 30;

/**
 * The longest source position addressable, in ms — 24 hours.
 *
 * Not a limit any real session approaches; it is there so an absurd `?start=`
 * is refused outright instead of becoming an `-ss` that makes ffmpeg read to the
 * end of an 800MB file before discovering there is nothing there.
 */
const MAX_SOURCE_MS = 24 * 60 * 60 * 1000;

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

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
 *
 * Those two fields are no longer produced, but this hashes the bytes on disk
 * and 2505 shipped swings still carry them -- and an integral float is a
 * property of the format, not of any one field, so the hazard outlives them.
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

/**
 * Every directory under `out/` that has a `swings/` child, sorted.
 *
 * One video is one session: `tennisproc run raw/IMG_0304.MOV` writes
 * `out/IMG_0304/`, so a tree holding one afternoon of footage holds one
 * directory per source file. This used to return the first match and stop,
 * which was indistinguishable from correct while `out/` held the single
 * session the plan built it with — and silently hid eight of nine the moment
 * it did not.
 *
 * Enumerating is also what makes `?session=` safe: a requested name is checked
 * against this list rather than joined onto a path, so no traversal, absolute
 * path or symlink is expressible through it.
 */
function listSessions(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .filter((name) => hasSwings(join(root, name, 'swings')));
}

/**
 * Whether a `swings/` directory holds at least one swing.
 *
 * An interrupted run leaves the directory behind empty — `out/IMG_0308` is one,
 * killed seconds after it started. Listing it would put a name in the picker
 * that cannot be selected: an empty session sends no clips, `loadEtlClips`
 * reads that as "no tree" and keeps what is loaded, and the dropdown snaps back
 * to the previous name with nothing said. Better not to offer it.
 */
function hasSwings(swingsDir: string): boolean {
  if (!existsSync(swingsDir)) return false;
  try {
    return readdirSync(swingsDir).some((d) => d.startsWith('swing_'));
  } catch {
    return false;
  }
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

/**
 * One session's swings, plus the names of every session beside it.
 *
 * `requested` names which one to read. An unknown name is NOT quietly replaced
 * by the default: the caller asked for a specific session, and answering with a
 * different one under a `session` field it will then write edits back through
 * is how a reviewer's labels would land in the wrong tree. The route 404s
 * instead.
 */
function readSession(root: string, requested?: string) {
  const sessions = listSessions(root);
  if (sessions.length === 0) return null;
  if (requested !== undefined && !sessions.includes(requested)) return null;
  const session = requested ?? sessions[0];

  const swingsDir = join(root, session, 'swings');
  const swings = readdirSync(swingsDir)
    .filter((d) => d.startsWith('swing_'))
    .sort()
    .flatMap((dir) => {
      const metaPath = join(swingsDir, dir, 'metadata.json');
      if (!existsSync(metaPath)) return [];
      // Guarded like the user-edit read below: an unparseable document costs
      // its own swing. Unguarded it threw, 500ing the route, and the app fell
      // back to seed data with no message.
      let raw;
      let metadata;
      try {
        raw = readFileSync(metaPath, 'utf-8');
        metadata = JSON.parse(raw) as Json;
      } catch {
        return [];
      }
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

  // Guarded rather than asserted: this is parsed file content, and a swing
  // whose `source` is missing or malformed should report "unknown", not crash
  // the route that serves every other swing beside it.
  const first = swings.length > 0 ? swings[0].doc.source : undefined;
  const source = isObject(first) ? first : null;

  // The session's playable video, read from the session document rather than
  // a swing: it describes the session, and unlike `source` it has no reason to
  // be denormalized into 108 copies. Null covers three cases the app treats
  // alike — a tree written before proxies, a session killed before its document
  // was written, and one whose source video was gone at transcode time.
  const sessionDoc = readJson(join(root, session, 'metadata.json'));
  const rawProxy = isObject(sessionDoc) ? sessionDoc.proxy : undefined;
  const proxy = isObject(rawProxy) && typeof rawProxy.file === 'string' ? rawProxy : null;

  // How the detector was tuned, and what it threw away. Neither is derivable
  // from the swings: `rendered` counts what survived, so a session that dropped
  // 40 candidates looks identical to one that found 108 cleanly unless the
  // histogram says otherwise. This is the only place a reviewer can see that.
  const rawSettings = isObject(sessionDoc) ? sessionDoc.settings : undefined;
  const settings = isObject(rawSettings) ? rawSettings : null;
  const rawDetection = isObject(sessionDoc) ? sessionDoc.detection : undefined;
  const detection = isObject(rawDetection) ? rawDetection : null;

  // Which sessions can actually be PLAYED, not merely listed. The keyframe view
  // seeks a source video, so a session with no proxy is not a destination there
  // — offering it in the picker only to answer "no source video" wastes the
  // click. The other views read stills and clips, so they still list them all.
  const playable = sessions.filter((name) => {
    const doc = readJson(join(root, name, 'metadata.json'));
    const p = isObject(doc) ? doc.proxy : undefined;
    return isObject(p) && typeof p.file === 'string' && existsSync(join(root, name, p.file));
  });

  return { session, sessions, playable, swings, source, proxy, settings, detection };
}

/**
 * The per-frame object export for a session, decompressed and parsed.
 *
 * Null covers every "there is no overlay for this session" case alike — the
 * detector was never run over it, the file is half-written, the header is
 * unusable — because the app's answer to all of them is the same: draw nothing.
 * None of them is an error worth showing a reviewer.
 *
 * `session` is checked against `listSessions` rather than joined onto a path,
 * the same guard `?session=` uses, so no traversal or absolute path is
 * expressible through the route. The filename is fixed here, like `PROXY`: it
 * comes from this file, never from the request.
 */
export function readObjects(root: string, session: string): ObjectsDoc | null {
  const text = readSessionGzip(root, session, OBJECTS);
  return text === null ? null : parseObjectsJsonl(text);
}

/**
 * A gzipped export inside a session directory, decompressed, or null.
 *
 * `session` is checked against `listSessions` rather than joined onto a path,
 * the same guard `?session=` uses, so no traversal or absolute path is
 * expressible through it. `rel` comes from this file, never from the request.
 */
function readSessionGzip(root: string, session: string, rel: string): string | null {
  if (!listSessions(root).includes(session)) return null;
  const full = safeJoin(root, join(session, rel));
  if (full === null) return null;

  try {
    // Bounded because `gunzipSync` otherwise allocates whatever the stream
    // claims. A native-rate export of a nine-minute session is about 30k lines
    // and well under 20MB, so this is an order of magnitude of headroom rather
    // than a limit any real file approaches.
    return gunzipSync(readFileSync(full), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * The ball candidates for a session, decompressed and parsed.
 *
 * Null covers every "there is nothing to label here" case alike, for
 * `readObjects`' reason: the candidate pass is run over a hand-picked sample of
 * sessions, so most have none, and that is not an error a reviewer can act on.
 *
 * A HALF-WRITTEN file is not one of those cases and must not become one. The
 * export takes minutes of GPU time and is written as it goes, so a truncated
 * final line is its ordinary state while it is being produced — `parseBallCandidates`
 * keeps every complete line before it, and labelling those is real work.
 */
export function readBallCandidates(root: string, session: string): BallCandidatesDoc | null {
  const text = readSessionGzip(root, session, BALL_CANDIDATES);
  return text === null ? null : parseBallCandidates(text);
}

/**
 * Where a session's `ball-labels.json` lives, or the status to answer with.
 *
 * Separate from the routes for `resolveWriteTarget`'s reason: these are the
 * checks that keep the route inside a real session directory, and reaching them
 * only through a live dev server means they are tested only as far as somebody
 * remembers to stand one up.
 *
 * The session name is checked against `listSessions` and never joined onto a
 * path from the request, so `../` and an absolute path are both inexpressible.
 * The final component is then checked for a symlink, because a write follows one
 * — a planted `ball-labels.json -> metadata.json` would otherwise let this route
 * overwrite ETL output, exactly as it would through `/api/swings`. A target that
 * does not exist yet is the normal first write.
 */
export function resolveBallLabels(
  root: string,
  session: string,
): { target: string } | { status: 403 | 404 } {
  if (!listSessions(root).includes(session)) return { status: 404 };
  const dir = safeJoin(root, session);
  if (dir === null || !statSync(dir).isDirectory()) return { status: 404 };

  const target = join(dir, BALL_LABELS);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    return { status: 403 };
  }
  return { target };
}

/**
 * The labels already on disk for a session, or the status to answer with.
 *
 * "No file yet" (404) and "a file this version cannot read" (409) are kept
 * apart, and that distinction is the whole reason this returns a status rather
 * than a nullable document. The first is the ordinary state of every session
 * nobody has labelled, and the app must open on an empty pass there. The second
 * is somebody's ground truth in a shape this build does not understand — a
 * future schema, a hand edit, a half-written file — and answering 404 to it
 * would invite the client to start from empty and PUT the whole thing away.
 */
export type BallLabelsRead = { doc: BallLabelsDoc } | { status: 403 | 404 | 409 };

export function readBallLabels(root: string, session: string): BallLabelsRead {
  const resolved = resolveBallLabels(root, session);
  if (!('target' in resolved)) return resolved;
  if (!existsSync(resolved.target)) return { status: 404 };
  const doc = parseBallLabels(readJson(resolved.target));
  return doc === null ? { status: 409 } : { doc };
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

/**
 * A non-negative decimal, and nothing else.
 *
 * Deliberately narrower than `Number()`, which reads `' 12 '` as 12, `'0x10'` as
 * 16, `'1e999'` as Infinity and `''` as 0 — that last one is why a bare
 * `Number(query.get('start'))` accepts a missing parameter as "the start of the
 * video" rather than refusing it.
 */
const DECIMAL = /^\d+(?:\.\d+)?$/;

function decimal(raw: string | null): number | null {
  if (raw === null || !DECIMAL.test(raw)) return null;
  const n = Number(raw);
  // A 400-digit literal passes the pattern and overflows to Infinity.
  return Number.isFinite(n) ? n : null;
}

/** What ffmpeg should cut, or the status to answer with. */
export type ClipCut =
  | { source: string; startMs: number; endMs: number; fileName: string }
  | { status: 400 | 404; error: string };

/**
 * Validates a `GET /api/clip/<session>/<swing_dir>` request into cut arguments.
 *
 * Factored out of the route for the reason `resolveWriteTarget` is: these are
 * the checks that keep an ffmpeg invocation away from files it has no business
 * reading, and reaching them through a live dev server means they are tested
 * only as far as somebody remembers to stand one up.
 *
 * The order of the checks is itself load-bearing. `rel` is matched against
 * `SWING_DIR` FIRST, so `../../etc/passwd` and `IMG_0684` alike are refused on
 * shape before any path is built from them; `safeJoin` is then a second line
 * rather than the only one. Numbers are validated before the filesystem is
 * touched, so a malformed range costs a regex rather than three stats.
 *
 * Bounds are checked AFTER padding, because the padded interval is what gets
 * encoded — a 100s window with a 30s pad is a 160s cut however innocent each
 * half looks alone.
 */
export function resolveClipCut(root: string, rel: string, query: URLSearchParams): ClipCut {
  if (!SWING_DIR.test(rel)) return { status: 404, error: 'not a swing directory' };

  const start = decimal(query.get('start'));
  const end = decimal(query.get('end'));
  if (start === null || end === null) {
    return { status: 400, error: 'start and end must be non-negative milliseconds' };
  }
  if (end <= start) return { status: 400, error: 'end must be after start' };
  if (end > MAX_SOURCE_MS) return { status: 400, error: 'range past the end of any session' };

  // Absent means no padding, which is what the URL builder relies on when it
  // leaves `pad` off. Present but unparseable is a refusal, not a fallback to
  // zero: the caller asked for a wider clip and would be handed a narrower one.
  const rawPad = query.get('pad');
  const padS = rawPad === null ? 0 : decimal(rawPad);
  if (padS === null || padS > MAX_PAD_S) {
    return { status: 400, error: `pad must be 0-${MAX_PAD_S} seconds` };
  }

  // Clamped at zero rather than refused: padding a swing at 0:01 by 2s is an
  // ordinary request, and the answer is the first second of the video.
  const startMs = Math.max(0, Math.round(start - padS * 1000));
  const endMs = Math.round(end + padS * 1000);
  if (endMs - startMs > MAX_CLIP_MS) {
    return { status: 400, error: `range longer than ${MAX_CLIP_MS / 1000}s` };
  }

  const session = rel.slice(0, rel.indexOf('/'));
  const source = safeJoin(root, join(session, PROXY));
  // A tree written before proxies existed, or a run killed during transcode.
  // Distinguished from a bad request on purpose: nothing about the URL is wrong.
  if (source === null || !statSync(source).isFile()) {
    return { status: 404, error: 'no source video for this session' };
  }

  // Checked even though nothing below reads it: a URL naming a swing that does
  // not exist should 404 rather than quietly hand back a cut of the session,
  // which is a clip of something the caller never asked about.
  const dir = safeJoin(root, rel);
  if (dir === null || !statSync(dir).isDirectory()) {
    return { status: 404, error: 'no such swing' };
  }

  return {
    source,
    startMs,
    endMs,
    // The padding is already in `startMs`, so it is not passed again.
    fileName: clipExportFileName({
      session,
      dir: rel.slice(session.length + 1),
      startMs,
      endMs,
    }),
  };
}

/**
 * One media file, resolved and read through a SINGLE open descriptor.
 *
 * The route used to consult the path three times — `safeJoin`'s `existsSync` and
 * `realpathSync`, then `statSync(full).isFile()`, then `readFileSync(full)` — so
 * nothing tied the thing it checked to the thing it read. Between the stat and
 * the read the name could be repointed at a directory, a device, or a file
 * outside the tree, and the containment check had already passed
 * (CodeQL js/file-system-race, high).
 *
 * Opening first closes that window: `fstatSync` and the read both address the
 * inode the descriptor holds, whatever the path means by then. `O_NOFOLLOW` is
 * safe *because* `safeJoin` returns a realpath — its final component is not a
 * symlink, so refusing one can only mean the name was swapped after the check.
 *
 * The residual window is `safeJoin`'s own: containment is decided from a path,
 * and only a path. That is inherent to checking a tree by name, and this
 * middleware is dev-only.
 */
export function openMedia(
  root: string,
  rel: string,
): { fd: number; size: number; type: string } | null {
  const full = safeJoin(root, rel);
  if (full === null) return null;

  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // Gone, unreadable, a dangling or freshly-planted symlink.
    return null;
  }
  try {
    // A directory opens happily on Linux; only the descriptor can say what it is.
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return null;
    }
    return {
      fd,
      size: stat.size,
      type: MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
    };
  } catch {
    closeSync(fd);
    return null;
  }
}

/**
 * Whole-file read, for callers that want the bytes rather than a stream.
 *
 * The right shape for a `metadata.json` or a 40 KB still, and the wrong one for
 * video — see `parseRange` — so the media route no longer goes through it.
 */
export function readMedia(root: string, rel: string): { body: Buffer; type: string } | null {
  const opened = openMedia(root, rel);
  if (opened === null) return null;
  try {
    return { body: readFileSync(opened.fd), type: opened.type };
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * A `Range` header against a known size, as a byte interval.
 *
 * `<video>` cannot seek without this. A browser asked to scrub an 8-minute
 * source sends `Range: bytes=41943040-` for the moment it wants; a server that
 * ignores the header and answers 200 with the whole file leaves the element
 * downloading from zero to reach a swing at 6:00, and Safari declines to play
 * at all. Answering 206 turns a seek into one short read — measured at 24-36ms
 * into an 864MB source, against a whole-file read of the same file.
 *
 * Only the single-interval form is honoured. Multi-range (`bytes=0-9,20-29`) is
 * legal HTTP that no video element sends, so it is refused outright rather than
 * half-implemented into a response that claims to be what was asked for.
 *
 * Returns null when there is no usable header, meaning the caller should answer
 * 200 with the whole file.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // A suffix range (`bytes=-500`) asks for the LAST n bytes. An empty file has
  // no last byte, so no suffix over it can be satisfied.
  if (rawStart === '') {
    const wanted = Number(rawEnd);
    if (wanted === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }

  const start = Number(rawStart);
  // `start === size` is out of range, not an empty tail: the last valid offset
  // is `size - 1`. This is the case that must 416 rather than answer zero bytes
  // and let the element conclude it reached the end of the video.
  if (start >= size) return 'unsatisfiable';

  // An absent end means "to the last byte". One past the end is clamped rather
  // than refused, which is what RFC 9110 requires.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return 'unsatisfiable';

  return { start, end };
}

/**
 * The session name a `/api/<route>/<session>` URL addresses, or null.
 *
 * Null for a path that cannot be decoded — a lone `%` is not a valid escape and
 * throws URIError — which is a 400 rather than a lookup of the raw bytes.
 *
 * The name is never joined onto a path by any caller: every one of them checks
 * it against `listSessions` first, which is what makes traversal and absolute
 * paths inexpressible through these routes.
 */
function sessionFromUrl(url: string | undefined): string | null {
  try {
    return decodeURIComponent((url ?? '').split('?')[0]).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

export default function shotLab(): Plugin {
  return {
    name: 'shot-lab-etl',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/session', (req, res) => {
        try {
          // `?session=` picks which one; absent means the first, which is what
          // every caller predating the picker sends.
          const query = (req.url ?? '').split('?')[1] ?? '';
          const requested = new URLSearchParams(query).get('session') ?? undefined;
          const payload = readSession(OUT_ROOT(), requested);
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

      // `GET /api/objects/<session>` — every box the object detector found,
      // decompressed, for the overlay drawn over the playing video.
      //
      // 404 is the ORDINARY answer, not a failure: the export is an optional
      // extra pass, so most sessions have none. The client draws nothing and
      // says nothing, which is why this returns no body to distinguish "never
      // run" from "half-written" — neither changes what the app can do.
      server.middlewares.use('/api/objects', (req, res) => {
        const session = sessionFromUrl(req.url);
        if (session === null) {
          res.statusCode = 400;
          res.end();
          return;
        }

        let doc;
        try {
          doc = readObjects(OUT_ROOT(), session);
        } catch {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"error":"could not read the object export"}');
          return;
        }
        if (doc === null) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(doc));
      });

      // `GET /api/ball-candidates/<session>` — the windowed, native-rate ball
      // detections a human confirms or corrects in the labelling mode.
      //
      // 404 is the ORDINARY answer, as it is for `/api/objects`: the candidate
      // pass runs over a hand-picked sample of sessions. The client shows no
      // labelling controls at all rather than saying so.
      server.middlewares.use('/api/ball-candidates', (req, res) => {
        const session = sessionFromUrl(req.url);
        if (session === null) {
          res.statusCode = 400;
          res.end();
          return;
        }

        let doc;
        try {
          doc = readBallCandidates(OUT_ROOT(), session);
        } catch {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end('{"error":"could not read the ball candidates"}');
          return;
        }
        if (doc === null) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(doc));
      });

      // `GET|PUT /api/ball-labels/<session>` — the human's ground-truth ball
      // positions for a whole session.
      //
      // One route for both, because they address the same single file, and it is
      // one file per SESSION rather than per swing: the labels are keyed by
      // source timestamp so that re-detection, which renumbers every swing
      // directory, cannot orphan them.
      //
      // The PUT replaces the file wholesale. That is safe only because the
      // client refuses to send anything until it has read what is already there
      // — and because a document this build cannot parse answers 409 above
      // rather than 404, so "start from empty" is never the client's reading of
      // somebody else's labels.
      server.middlewares.use('/api/ball-labels', (req, res) => {
        const session = sessionFromUrl(req.url);
        if (session === null) {
          res.statusCode = 400;
          res.end();
          return;
        }

        if (req.method === 'GET') {
          let read;
          try {
            read = readBallLabels(OUT_ROOT(), session);
          } catch {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end('{"error":"could not read the ball labels"}');
            return;
          }
          if (!('doc' in read)) {
            res.statusCode = read.status;
            res.end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(read.doc));
          return;
        }

        if (req.method !== 'PUT') {
          res.statusCode = 405;
          res.end();
          return;
        }

        const resolved = resolveBallLabels(OUT_ROOT(), session);
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
          let doc: BallLabelsDoc | null = null;
          try {
            doc = parseBallLabels(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch {
            doc = null;
          }
          // Validated here, unlike `/api/swings`, which writes whatever JSON
          // parses. This file has no schema on the ETL side to catch a bad
          // document later: it IS the ground truth, and every later measurement
          // of a tracker is only as good as it. A body that is not a label
          // document is a bug in the client, not a reviewer's work at risk.
          if (doc === null) {
            res.statusCode = 400;
            res.end('{"error":"not a ball-labels document"}');
            return;
          }
          // The name in the body must be the one in the URL. Nothing derived
          // from the body reaches the path, so this cannot be a traversal —
          // it is `readSession`'s rule about answering with a session other
          // than the one asked for, applied to the write side: a mismatch means
          // labels are about to be filed under a session they did not come from.
          if (doc.session !== session) {
            res.statusCode = 409;
            res.end('{"error":"labels are for a different session"}');
            return;
          }
          try {
            writeFileSync(target, JSON.stringify(doc, null, 1) + '\n');
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 500;
            res.end('{"error":"could not write the ball labels"}');
          }
        });
      });

      // Streamed, not buffered, and Range-aware: this route serves the session's
      // full source video, which is measured in hundreds of megabytes. Reading
      // one into a Buffer per request is both an allocation the dev server does
      // not survive repeating and, without `Content-Range`, a video the browser
      // cannot seek. `createReadStream` takes the descriptor `openMedia` already
      // validated, so the bytes sent come from the inode that was checked rather
      // than from whatever the path names by the time the read happens.
      server.middlewares.use('/api/media', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const media = openMedia(OUT_ROOT(), rel);
        if (media === null) {
          res.statusCode = 404;
          res.end();
          return;
        }

        const { fd, size, type } = media;
        const range = parseRange(req.headers.range, size);

        if (range === 'unsatisfiable') {
          closeSync(fd);
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          res.end();
          return;
        }

        res.setHeader('Content-Type', type);
        // Advertised on every response, not just partial ones: it is how the
        // element learns it may seek at all before it has asked for a range.
        res.setHeader('Accept-Ranges', 'bytes');

        const start = range === null ? 0 : range.start;
        const end = range === null ? size - 1 : range.end;
        if (range !== null) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        // Zero-length is legal for an empty file; `end - start + 1` is then 0.
        res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);

        if (req.method === 'HEAD' || size === 0) {
          closeSync(fd);
          res.end();
          return;
        }

        const stream = createReadStream('', { fd, start, end, autoClose: true });
        // `autoClose` closes the descriptor on end AND on error, so the only
        // leak left to guard is the client vanishing mid-stream — which emits
        // neither on the stream itself.
        res.on('close', () => stream.destroy());
        stream.on('error', () => {
          res.statusCode = 500;
          res.end();
        });
        stream.pipe(res);
      });

      // `GET /api/clip/<session>/swings/swing_NNN?start=&end=&pad=`
      //
      // Cuts one swing out of the session's `source.mp4` and hands it back as a
      // download. There is nothing on disk to link to any more — the redesign
      // replaced 108 pre-rendered `clip.mp4` files with one full-length proxy
      // and a pair of timestamps per swing — so the file a reviewer wants to
      // keep or send to a coach only exists if this route makes it.
      //
      // Encoded to a temp file rather than piped straight to the response,
      // because `-movflags +faststart` rewrites the moov atom to the head of the
      // file once the encode has finished, and a socket cannot be rewound. The
      // fragmented-MP4 alternative streams but produces a file some players
      // handle worse, which is the wrong trade for an artefact meant to be kept.
      // A cut is bounded to `MAX_CLIP_MS`, so the file is a few megabytes.
      server.middlewares.use('/api/clip', (req, res) => {
        const fail = (status: number, error: string) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error }));
        };

        if (req.method !== 'GET') {
          fail(405, 'use GET');
          return;
        }

        const [rawPath, rawQuery = ''] = (req.url ?? '').split('?');
        let rel: string;
        try {
          rel = decodeURIComponent(rawPath).replace(/^\/+/, '');
        } catch {
          // A lone `%` is not a valid escape and throws URIError.
          fail(400, 'malformed path');
          return;
        }

        let cut;
        try {
          cut = resolveClipCut(OUT_ROOT(), rel, new URLSearchParams(rawQuery));
        } catch {
          fail(500, 'could not resolve the clip');
          return;
        }
        if ('status' in cut) {
          fail(cut.status, cut.error);
          return;
        }

        // ffmpeg is spawned with an argv array and no shell, so nothing in the
        // URL can be read as a command however it survived validation. `source`
        // is a realpath `safeJoin` proved is inside `out/`, and the two numbers
        // are formatted from parsed doubles rather than passed through as text.
        const workDir = mkdtempSync(join(tmpdir(), 'shot-lab-clip-'));
        // A fixed name: the download's name is the response header's job, and a
        // constant here means nothing derived from the request reaches the
        // filesystem at all.
        const dest = join(workDir, 'clip.mp4');
        const clean = () => rmSync(workDir, { recursive: true, force: true });

        // `-ss` before `-i` seeks first and decodes after, and the re-encode is
        // what makes the cut land exactly where asked: `-c copy` can only start
        // at a keyframe, which on this proxy is up to two seconds early. Same
        // reasoning, and the same encoder settings, as `cut_clip` in
        // `tennisproc/render.py`. Audio is kept, unlike there: a clip a reviewer
        // sends to a coach is worth more with the sound of contact in it.
        const ffmpeg = spawn(
          'ffmpeg',
          [
            '-v', 'error',
            '-ss', (cut.startMs / 1000).toFixed(3),
            '-i', cut.source,
            '-t', ((cut.endMs - cut.startMs) / 1000).toFixed(3),
            '-c:v', 'libx264', '-profile:v', 'high', '-crf', '26', '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            '-y', dest,
          ],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
            // A bounded cut should take seconds. The timeout is for the case
            // where ffmpeg wedges on a half-written proxy rather than for slow
            // ones, and without it that request holds a process forever.
            timeout: 120_000,
            killSignal: 'SIGKILL',
          },
        );

        let stderr = '';
        ffmpeg.stderr.setEncoding('utf-8');
        ffmpeg.stderr.on('data', (chunk: string) => {
          // Bounded: `-v error` says little, but a broken input can say it once
          // per frame and there is no reason to hold that in memory.
          if (stderr.length < 4096) stderr += chunk;
        });

        // The client navigating away or cancelling the download must stop the
        // encode too. Without this, a reviewer clicking Export twice leaves the
        // first ffmpeg running to completion for a file nobody will read.
        let aborted = false;
        res.on('close', () => {
          if (!res.writableEnded) {
            aborted = true;
            ffmpeg.kill('SIGKILL');
          }
        });

        ffmpeg.on('error', () => {
          clean();
          if (!aborted) fail(500, 'ffmpeg is not available');
        });

        ffmpeg.on('close', (code) => {
          if (aborted) {
            clean();
            return;
          }
          if (code !== 0 || !existsSync(dest)) {
            clean();
            fail(500, `ffmpeg failed: ${stderr.trim() || `exit ${String(code)}`}`);
            return;
          }

          res.setHeader('Content-Type', 'video/mp4');
          res.setHeader('Content-Length', statSync(dest).size);
          // The filename is quoted, and `clipExportFileName` has already reduced
          // it to `[A-Za-z0-9._-]`, so no session name can close the quote and
          // append a header directive of its own.
          res.setHeader('Content-Disposition', `attachment; filename="${cut.fileName}"`);

          const stream = createReadStream(dest);
          // The temp directory goes on end, on error and on the client vanishing
          // mid-download — the last of which emits nothing on the stream itself.
          stream.on('close', clean);
          res.on('close', () => stream.destroy());
          stream.on('error', () => {
            res.statusCode = 500;
            res.end();
          });
          stream.pipe(res);
        });
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
            writeFileSync(target, JSON.stringify(doc, null, 1) + '\n');
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
  listSessions,
  overlayEdit,
  readSession,
  BALL_CANDIDATES,
  BALL_LABELS,
  OBJECTS,
  resolveWriteTarget,
  safeJoin,
  WRITABLE,
};
