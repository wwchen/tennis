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
    const clips = await loadEtlClips();
    expect(clips).not.toBeNull();
    expect(clips).toHaveLength(1);
    expect(clips?.[0].id).toBe('IMG_0304/swing_001');
  });

  it('returns null when there is no out/ tree, so the seed stands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await loadEtlClips()).toBeNull();
  });

  it('returns null rather than throwing when the dev server is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await loadEtlClips()).toBeNull();
  });
});
