import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adaptSwing } from '@/domain/etl';
import type { EtlSwingDoc } from '@/domain/etl-types';
import { docHash, overlayEdit, readSession, resolveWriteTarget, safeJoin } from './vite-plugin-shot-lab';

const FIXTURE = join(process.cwd(), 'src', 'domain', '__fixtures__', 'swing-real.json');

describe('safeJoin', () => {
  const tmpDir = join(process.cwd(), '.test-tmp');
  const root = join(tmpDir, 'root');

  beforeEach(() => {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'safe'), { recursive: true });
    writeFileSync(join(root, 'safe', 'file.txt'), 'safe content');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows files inside the root', () => {
    const result = safeJoin(root, 'safe/file.txt');
    expect(result).not.toBeNull();
    expect(result).toContain('safe');
  });

  it('rejects path traversal attempts', () => {
    writeFileSync(join(tmpDir, 'outside.txt'), 'outside');
    const result = safeJoin(root, '../outside.txt');
    expect(result).toBeNull();
  });

  it('rejects symlinks pointing outside the root', () => {
    mkdirSync(join(tmpDir, 'outside-target'), { recursive: true });
    writeFileSync(join(tmpDir, 'outside-target', 'secret.txt'), 'secret');
    symlinkSync(join(tmpDir, 'outside-target'), join(root, 'escape'));

    const result = safeJoin(root, 'escape/secret.txt');
    expect(result).toBeNull();
  });

  it('returns null for non-existent paths', () => {
    const result = safeJoin(root, 'does-not-exist.txt');
    expect(result).toBeNull();
  });
});

describe('docHash', () => {
  it('matches the pinned Python doc_hash of the real fixture', () => {
    // The same constant tests/test_app_writeback.py asserts against
    // schema.doc_hash. Both sides pin it so neither can drift alone.
    expect(docHash(readFileSync(FIXTURE, 'utf-8'))).toBe('sha256:6caa72ffd3c91439');
  });

  it('keeps an integral float distinct from the same-valued int', () => {
    // `json.dumps` writes a float with repr(), so 1.0 stays "1.0" and 1 stays
    // "1". JSON.stringify collapses both to "1", which made docHash disagree
    // with Python on 4 of the 42 swings in the sample session.
    const asFloat = docHash('{"a": 1.0}');
    const asInt = docHash('{"a": 1}');
    expect(asFloat).not.toBe(asInt);
    // Values pinned from schema.doc_hash; see the Python test of the same name.
    expect(asFloat).toBe('sha256:c29a44abc114a1d7');
    expect(asInt).toBe('sha256:015abd7f5cc57a2d');
  });

  it('matches Python on a whole swing carrying an integral float', () => {
    // The document class the old implementation got wrong: swings 010, 021, 031
    // and 040 of the sample session each carry one of these. Pinned from
    // schema.doc_hash; tests/test_app_writeback.py pins the same value.
    const raw = readFileSync(FIXTURE, 'utf-8')
      .replace('"contact_offset": 0.1', '"contact_offset": -1.0')
      .replace('"wrist_peak_speed": 32.8358', '"wrist_peak_speed": 40.0');
    expect(raw).toContain('-1.0');
    expect(raw).toContain('40.0');
    expect(docHash(raw)).toBe('sha256:501eafc9a1f2f70d');
  });

  it('escapes non-ASCII the way ensure_ascii=True does', () => {
    // A reviewer's note is free text, so this is reachable. Pinned from
    // schema.doc_hash.
    expect(docHash('{"notes": "caf\\u00e9 \\u2014 \\ud83d\\ude00 ok"}')).toBe(
      'sha256:888819fcfbe95344',
    );
    expect(docHash('{"notes": "tab\\there"}')).toBe('sha256:a85415c12edc4b91');
  });

  it('agrees with repr() on the float shapes Python can emit', () => {
    // repr() drops the exponent below 1e16 and above 1e-5, so `1e-3` hashes as
    // `0.001` and `2.5e3` as `2500.0`, and -0.0 keeps its sign.
    expect(docHash('{"a": 1.5, "b": -0.0, "c": 1e-3, "d": 2.5e3}')).toBe(
      'sha256:8119dc1142701e82',
    );
  });

  it('is key-order independent, like sort_keys=True', () => {
    expect(docHash('{"b": 2, "a": 1.0}')).toBe(docHash('{"a": 1.0, "b": 2}'));
  });

  it('ignores the edit block, so a review cannot change its own hash', () => {
    const bare = '{"id": "x", "labels": {"quality": null}}';
    const reviewed = '{"id": "x", "labels": {"quality": null}, "edit": {"reviewed": true}}';
    expect(docHash(reviewed)).toBe(docHash(bare));
  });

  it('does not mistake a number inside a string for a literal', () => {
    // Frame filenames are full of digits; boxing one would corrupt the blob.
    expect(docHash('{"file": "frames/frame_0024.jpg"}')).toBe(
      docHash('{"file": "frames/frame_0024.jpg"}'),
    );
    expect(docHash('{"a": "1.0"}')).not.toBe(docHash('{"a": 1.0}'));
  });
});

describe('overlayEdit', () => {
  const metadata = () => JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Record<string, unknown>;

  it('leaves the metadata alone when there is no edit', () => {
    expect(overlayEdit(metadata(), null)).toEqual(metadata());
  });

  it('lets a non-null label from the edit win, field by field', () => {
    const merged = overlayEdit(metadata(), {
      labels: { stroke: 'backhand', quality: 4, player_slot: null, tags: [] },
    });
    const labels = merged.labels as Record<string, unknown>;
    expect(labels.stroke).toBe('backhand');
    expect(labels.quality).toBe(4);
    // A null in the edit must not erase what the ETL knew.
    expect(labels.player_slot).toBe((metadata().labels as Record<string, unknown>).player_slot);
    // Empty tags do not overwrite; non-empty do.
    expect(labels.tags).toEqual([]);
    const tagged = overlayEdit(metadata(), { labels: { tags: ['late'] } });
    expect((tagged.labels as Record<string, unknown>).tags).toEqual(['late']);
  });

  it('lands a stage on the frame with the same source_ms, not the same index', () => {
    const meta = metadata();
    const frames = meta.frames as { source_ms: number }[];
    const contactMs = (meta.detection as { contact_ms: number }).contact_ms;

    const merged = overlayEdit(meta, {
      // Deliberately out of order and offset from where contact sits in the
      // array, so an index-based merge would tag the wrong moment.
      frames: [{ source_ms: contactMs, stage: 'contact' }],
    });

    const tagged = (merged.frames as { source_ms: number; stage: string | null }[]).filter(
      (f) => f.stage === 'contact',
    );
    expect(tagged).toHaveLength(1);
    expect(tagged[0].source_ms).toBe(contactMs);
    expect(merged.frames as unknown[]).toHaveLength(frames.length);
  });

  it('drops an edited frame whose source_ms is not in the metadata', () => {
    const merged = overlayEdit(metadata(), {
      frames: [{ source_ms: 999999, stage: 'finish' }],
    });
    const stages = (merged.frames as { stage: string | null }[]).map((f) => f.stage);
    expect(stages.every((s) => s === null)).toBe(true);
    expect(merged.frames as unknown[]).toHaveLength((metadata().frames as unknown[]).length);
  });

  it('refuses to let a hostile edit rewrite an ETL-owned block', () => {
    const meta = metadata();
    const merged = overlayEdit(meta, {
      source: { name: 'attacker.mp4', path: '/tmp/evil.mp4' },
      trim: { file: 'evil.mp4', source_start_ms: 0, source_end_ms: 1 },
      crop: { x: 0, y: 0, w: 1, h: 1 },
      detection: { contact_ms: 0, verified: false },
      measurements: null,
      labels: { stroke: 'serve' },
    });

    expect(merged.source).toEqual(meta.source);
    expect(merged.trim).toEqual(meta.trim);
    expect(merged.crop).toEqual(meta.crop);
    expect(merged.detection).toEqual(meta.detection);
    expect(merged.measurements).toEqual(meta.measurements);
    // The one thing the edit is allowed to say still lands.
    expect((merged.labels as Record<string, unknown>).stroke).toBe('serve');
  });

  it('carries the edit block through, which is what marks a clip triaged', () => {
    const merged = overlayEdit(metadata(), {
      edit: { by: 'reviewer', at: '2026-08-16T12:00:00Z', reviewed: true },
    });
    expect(merged.edit).toEqual({ by: 'reviewer', at: '2026-08-16T12:00:00Z', reviewed: true });
  });

  it('does not mutate its inputs', () => {
    const meta = metadata();
    const edit = { labels: { stroke: 'volley', tags: ['deep'] } };
    overlayEdit(meta, edit);
    expect(meta).toEqual(metadata());
    expect(edit).toEqual({ labels: { stroke: 'volley', tags: ['deep'] } });
  });
});

describe('readSession', () => {
  const tmpDir = join(process.cwd(), '.test-tmp-session');
  const swingDir = join(tmpDir, 'IMG_0304', 'swings', 'swing_001');
  const metaRaw = () => readFileSync(FIXTURE, 'utf-8');

  beforeEach(() => {
    mkdirSync(swingDir, { recursive: true });
    writeFileSync(join(swingDir, 'metadata.json'), metaRaw());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('overlays user-edit.json so the human’s work survives a reload', () => {
    const meta = JSON.parse(metaRaw()) as Record<string, unknown>;
    const contactMs = (meta.detection as { contact_ms: number }).contact_ms;
    writeFileSync(
      join(swingDir, 'user-edit.json'),
      JSON.stringify({
        ...meta,
        labels: { ...(meta.labels as object), stroke: 'backhand', quality: 4, notes: 'late' },
        frames: [{ source_ms: contactMs, stage: 'contact' }],
        edit: { by: 'reviewer', at: '2026-08-16T12:00:00Z', reviewed: true },
      }),
    );

    const payload = readSession(tmpDir);
    expect(payload).not.toBeNull();
    const entry = payload!.swings[0];

    // Straight through the read adapter: what the UI will actually render.
    const clip = adaptSwing(entry.doc as unknown as EtlSwingDoc);
    expect(clip.stroke).toBe('Backhand');
    expect(clip.grade).toBe('good');
    expect(clip.note).toBe('late');
    expect(clip.triaged).toBe(true);
    expect(clip.frames.find((f) => f.phase === 'contact')?.sourceMs).toBe(contactMs);
  });

  it('hashes the metadata alone, never the merged document', () => {
    const before = readSession(tmpDir)!.swings[0].hash;
    expect(before).toBe('sha256:6caa72ffd3c91439');

    // edit.against records which ETL output was reviewed. If the hash followed
    // the merge, writing an edit would move the target and every review would
    // read as stale against itself.
    writeFileSync(
      join(swingDir, 'user-edit.json'),
      JSON.stringify({
        labels: { stroke: 'serve', quality: 5 },
        edit: { by: 'reviewer', at: 'now', against: before, reviewed: true },
      }),
    );
    expect(readSession(tmpDir)!.swings[0].hash).toBe(before);
  });

  it('still refuses an ETL-owned block from the edit on the read path', () => {
    const meta = JSON.parse(metaRaw()) as Record<string, unknown>;
    writeFileSync(
      join(swingDir, 'user-edit.json'),
      JSON.stringify({
        source: { name: 'attacker.mp4' },
        detection: { ...(meta.detection as object), contact_ms: 0 },
        edit: { by: 'attacker', at: 'now', reviewed: true },
      }),
    );

    const doc = readSession(tmpDir)!.swings[0].doc;
    expect(doc.source).toEqual(meta.source);
    expect(doc.detection).toEqual(meta.detection);
  });

  it('treats a corrupt user-edit.json as absent rather than failing the session', () => {
    writeFileSync(join(swingDir, 'user-edit.json'), '{not json');
    const doc = readSession(tmpDir)!.swings[0].doc;
    expect(adaptSwing(doc as unknown as EtlSwingDoc).triaged).toBe(false);
  });
});

describe('resolveWriteTarget', () => {
  const tmpDir = join(process.cwd(), '.test-tmp-write');
  const swingDir = join(tmpDir, 'IMG_0304', 'swings', 'swing_001');

  beforeEach(() => {
    mkdirSync(swingDir, { recursive: true });
    mkdirSync(join(tmpDir, 'IMG_0304', 'work'), { recursive: true });
    writeFileSync(join(swingDir, 'metadata.json'), '{"id":"IMG_0304/swing_001"}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a swing directory whose user-edit.json does not exist yet', () => {
    const result = resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_001/user-edit');
    expect(result).toHaveProperty('target');
    expect('target' in result && result.target.endsWith('user-edit.json')).toBe(true);
  });

  it('404s a directory that is not a swing', () => {
    // Both of these used to return 204 and write outside a swing directory.
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/user-edit')).toEqual({ status: 404 });
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/work/user-edit')).toEqual({ status: 404 });
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/user-edit')).toEqual({ status: 404 });
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_abc/user-edit')).toEqual({
      status: 404,
    });
  });

  it('404s any filename but user-edit', () => {
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_001/metadata.json')).toEqual({
      status: 404,
    });
  });

  it('refuses a symlinked user-edit.json rather than writing through it', () => {
    // The demonstrated escape: link the one writable name at metadata.json and
    // the route overwrites ETL output.
    symlinkSync(join(swingDir, 'metadata.json'), join(swingDir, 'user-edit.json'));
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_001/user-edit')).toEqual({
      status: 403,
    });
    expect(readFileSync(join(swingDir, 'metadata.json'), 'utf-8')).toBe(
      '{"id":"IMG_0304/swing_001"}',
    );
  });

  it('refuses a symlink pointing outside the tree too', () => {
    writeFileSync(join(tmpDir, 'victim.txt'), 'untouched');
    symlinkSync(join(tmpDir, 'victim.txt'), join(swingDir, 'user-edit.json'));
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_001/user-edit')).toEqual({
      status: 403,
    });
  });

  it('allows overwriting a real user-edit.json', () => {
    writeFileSync(join(swingDir, 'user-edit.json'), '{}');
    expect(resolveWriteTarget(tmpDir, 'IMG_0304/swings/swing_001/user-edit')).toHaveProperty(
      'target',
    );
  });
});
