import { afterEach, describe, expect, it, vi } from 'vitest';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import { loadEtlClips } from './etl-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

const payload = {
  session: 'IMG_0304',
  swings: [{ dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing }],
};

describe('loadEtlClips', () => {
  it('adapts a session payload into clips', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }),
    );
    const result = await loadEtlClips();
    expect(result).not.toBeNull();
    expect(result?.clips).toHaveLength(1);
    expect(result?.clips[0].id).toBe('IMG_0304/swing_001');
    expect(result?.session).toBe('IMG_0304');
    expect(result?.entries).toHaveLength(1);
  });

  it('returns null when there is no out/ tree, so the seed stands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await loadEtlClips()).toBeNull();
  });

  it('returns null rather than throwing when the dev server is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await loadEtlClips()).toBeNull();
  });

  it('reports nothing skipped for a wholly readable session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }),
    );
    expect((await loadEtlClips())?.skipped).toEqual([]);
  });

  it('keeps the readable swings when one document is corrupt', async () => {
    // The whole point of the fix: a session is not all-or-nothing. This used to
    // return null, which is the "there is no out/ tree" signal — so the seed
    // stood in for 41 perfectly good swings.
    const mixed = {
      session: 'IMG_0304',
      swings: [
        { dir: 'swings/swing_001', hash: 'sha256:abc', doc: { id: 'broken' } },
        { dir: 'swings/swing_002', hash: 'sha256:def', doc: realSwing },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mixed) }),
    );
    const result = await loadEtlClips();
    expect(result?.clips).toHaveLength(1);
    expect(result?.entries.map((e) => e.dir)).toEqual(['swings/swing_002']);
    expect(result?.skipped.map((s) => s.dir)).toEqual(['swings/swing_001']);
  });

  it('does NOT fall back to the seed when every document is corrupt', async () => {
    // A tree that exists but is entirely unreadable is a failure, not the
    // absence of a tree. Returning null here would show seed data as though it
    // were the session — the exact silence this fix removes.
    const corruptPayload = {
      session: 'IMG_0304',
      swings: [{ dir: 'swings/swing_001', hash: 'sha256:abc', doc: { id: 'broken' } }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(corruptPayload) }),
    );
    const result = await loadEtlClips();
    expect(result).not.toBeNull();
    expect(result?.clips).toEqual([]);
    expect(result?.skipped).toHaveLength(1);
  });
});
