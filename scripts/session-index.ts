/**
 * Writes the static `/api/session` payloads the container serves.
 *
 * In dev, `/api/session` is a Node middleware that walks `out/` on every
 * request (`vite-plugin-shot-lab.ts`). The production image is Caddy serving
 * a directory, and deliberately stays that way: a filesystem-walking API
 * behind a public tunnel is a far larger surface than a `file_server`, and the
 * tree is immutable between ETL runs anyway. So the walk happens here, ahead
 * of time, and Caddy serves the result as files.
 *
 * The payloads come from `readSession` itself rather than a reimplementation,
 * so the static route cannot drift from the dev route it stands in for.
 *
 * Run it after every `tennisproc` run — `make session-index`, which `make up`
 * depends on. A stale index is not detectable from the app: it looks exactly
 * like a session you have not reviewed yet.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listSessions, readSession } from '../vite-plugin-shot-lab.ts';

/** Where under the out root the payloads land. Mirrored in the Caddyfile. */
export const INDEX_DIR = '_index';

/**
 * Session names the `?session=` route can address.
 *
 * Caddy interpolates the query value straight into the file path, so the
 * matcher there admits exactly this character set. A session whose directory
 * name falls outside it is reported rather than written: it would produce a
 * file nothing can request, and a picker entry that 404s is the failure mode
 * `hasSwings` already exists to prevent.
 */
const SERVABLE = /^[A-Za-z0-9._-]+$/;

export function writeSessionIndex(root: string): {
  written: string[];
  unaddressable: string[];
} {
  const dir = join(root, INDEX_DIR);
  // Rebuilt, not merged: a session deleted from the tree must lose its payload
  // too, or the picker keeps offering a name whose frames are gone.
  rmSync(dir, { recursive: true, force: true });

  const sessions = listSessions(root);
  if (sessions.length === 0) return { written: [], unaddressable: [] };

  // `default.json` and `by-name/` are separate directories on purpose: a
  // session directory legitimately named `_default` would otherwise clobber
  // the no-query payload.
  mkdirSync(join(dir, 'by-name'), { recursive: true });
  writeFileSync(join(dir, 'default.json'), JSON.stringify(readSession(root)));

  const written: string[] = [];
  const unaddressable: string[] = [];
  for (const session of sessions) {
    if (!SERVABLE.test(session)) {
      unaddressable.push(session);
      continue;
    }
    writeFileSync(
      join(dir, 'by-name', `${session}.json`),
      JSON.stringify(readSession(root, session)),
    );
    written.push(session);
  }
  return { written, unaddressable };
}

if (import.meta.main) {
  const root = resolve(process.env.SHOT_LAB_OUT ?? 'out');
  const { written, unaddressable } = writeSessionIndex(root);
  if (written.length === 0) {
    // Not an error: an empty tree is what a fresh clone has, and the app
    // handles a 404 from this route by keeping its seed data.
    process.stdout.write(`no sessions under ${root} — nothing to index\n`);
  } else {
    process.stdout.write(
      `indexed ${written.length} session(s) under ${root}: ${written.join(', ')}\n`,
    );
  }
  for (const name of unaddressable) {
    console.warn(`skipped ${name}: name is not addressable as ?session=`);
  }
}
