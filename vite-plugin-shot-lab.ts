import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

/**
 * Resolves a request path inside the output root, or returns null.
 *
 * Rejecting on the resolved prefix is what stops `../` in a URL from reaching
 * outside `out/` — checking the raw string would miss encoded traversals.
 */
function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full === root || full.startsWith(root + sep) ? full : null;
}

/** Mirrors `schema.doc_hash`: sorted-key JSON of everything but `edit`. */
function docHash(doc: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { edit: _edit, ...rest } = doc;
  const blob = JSON.stringify(sortKeys(rest));
  return 'sha256:' + createHash('sha256').update(blob).digest('hex').slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** First directory under `out/` that has a `swings/` child. */
function findSession(root: string): string | null {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort()) {
    if (existsSync(join(root, name, 'swings'))) return name;
  }
  return null;
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
      const doc = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
      return [{ dir: `swings/${dir}`, hash: docHash(doc), doc }];
    });

  return { session, swings };
}

export default function shotLab(): Plugin {
  return {
    name: 'shot-lab-etl',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/session', (_req, res) => {
        const payload = readSession(OUT_ROOT());
        if (payload === null) {
          res.statusCode = 404;
          res.end('{"error":"no session"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
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
    },
  };
}

export { docHash, safeJoin, WRITABLE };
