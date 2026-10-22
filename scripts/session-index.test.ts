import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSession } from '../vite-plugin-shot-lab.ts';
import { INDEX_DIR, writeSessionIndex } from './session-index.ts';

const tmpDir = join(process.cwd(), '.test-tmp-index');
const root = join(tmpDir, 'out');

/** A swing directory holding the smallest metadata `readSession` will accept. */
function swing(session: string, dir: string, doc: Record<string, unknown> = {}) {
  const path = join(root, session, 'swings', dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'metadata.json'), JSON.stringify({ id: dir, ...doc }));
}

/** The payload shape is the dev route's own, so the two cannot drift apart. */
type Payload = NonNullable<ReturnType<typeof readSession>>;

const readIndex = (rel: string) =>
  JSON.parse(readFileSync(join(root, INDEX_DIR, rel), 'utf-8')) as Payload;

beforeEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeSessionIndex', () => {
  it('writes one payload per session, byte-identical to the dev route', () => {
    swing('IMG_0304', 'swing_001');
    swing('IMG_0305', 'swing_001');

    const { written } = writeSessionIndex(root);

    expect(written).toEqual(['IMG_0304', 'IMG_0305']);
    for (const session of written) {
      expect(readIndex(`by-name/${session}.json`)).toEqual(readSession(root, session));
    }
  });

  it('serves the first session when no name is requested', () => {
    swing('IMG_0304', 'swing_001');
    swing('IMG_0305', 'swing_001');

    writeSessionIndex(root);

    // What `?session=` absent means, and the reason default.json exists rather
    // than the app asking for a name it does not know yet.
    expect(readIndex('default.json')).toEqual(readSession(root));
    expect(readIndex('default.json').session).toBe('IMG_0304');
  });

  it('lists every session in each payload, so the picker is complete', () => {
    swing('IMG_0304', 'swing_001');
    swing('IMG_0305', 'swing_001');

    writeSessionIndex(root);

    expect(readIndex('by-name/IMG_0305.json').sessions).toEqual(['IMG_0304', 'IMG_0305']);
  });

  it('drops payloads for sessions that left the tree', () => {
    swing('IMG_0304', 'swing_001');
    swing('IMG_0305', 'swing_001');
    writeSessionIndex(root);

    rmSync(join(root, 'IMG_0305'), { recursive: true });
    writeSessionIndex(root);

    // A stale payload would keep the name in the picker and 404 every frame
    // behind it — the index is rebuilt, never merged.
    expect(existsSync(join(root, INDEX_DIR, 'by-name', 'IMG_0305.json'))).toBe(false);
    expect(existsSync(join(root, INDEX_DIR, 'by-name', 'IMG_0304.json'))).toBe(true);
  });

  it('skips a session whose name the ?session= route cannot address', () => {
    swing('IMG_0304', 'swing_001');
    swing('has spaces', 'swing_001');

    const { written, unaddressable } = writeSessionIndex(root);

    expect(written).toEqual(['IMG_0304']);
    expect(unaddressable).toEqual(['has spaces']);
  });

  it('writes nothing at all for an empty tree', () => {
    const { written } = writeSessionIndex(root);

    // The app reads the resulting 404 as "no tree" and keeps its seed data,
    // which is the same thing a fresh clone sees in dev.
    expect(written).toEqual([]);
    expect(existsSync(join(root, INDEX_DIR))).toBe(false);
  });

  it('ignores an interrupted run that left an empty swings/ behind', () => {
    swing('IMG_0304', 'swing_001');
    mkdirSync(join(root, 'IMG_0308', 'swings'), { recursive: true });

    const { written } = writeSessionIndex(root);

    expect(written).toEqual(['IMG_0304']);
  });

  it('does not index itself on a second run', () => {
    swing('IMG_0304', 'swing_001');
    writeSessionIndex(root);

    const { written } = writeSessionIndex(root);

    // _index/ sits inside the tree listSessions walks; it has no swings/ child,
    // so it must never become a session name of its own.
    expect(written).toEqual(['IMG_0304']);
  });
});
