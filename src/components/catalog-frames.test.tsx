import { describe, expect, it } from 'vitest';
import type { Clip, Phase } from '@/domain/types';
import { clipFileName } from '@/domain/types';
import { phaseFrame } from '@/domain/window';

/**
 * The catalog's phase tiles must resolve to a frame on an UNREVIEWED clip.
 *
 * `frames[].phase` is a human label and the ETL ships every one null, so the
 * old `find(f => f.phase === phase)` matched nothing on every clip in a fresh
 * tree — which is what left the whole catalog view as empty boxes.
 */
const clipOf = (frames: Clip['frames']): Clip => ({
  id: 'IMG_0305/swing_001',
  player: 'left',
  stroke: null,
  rejected: false,
  duration: '0:03',
  triaged: false,
  grade: null,
  note: '',
  frames,
});

const etlFrames = (): Clip['frames'] =>
  [-1500, -1000, -500, 0, 500, 1000, 1500].map((off, i) => ({
    i,
    sourceMs: 10000 + off,
    offsetContactMs: off,
    phase: null,
    imageUrl: `/api/media/x/frames/frame_000${i}.jpg`,
  }));

describe('catalog phase frames', () => {
  it('finds a frame for every phase on an unlabelled clip', () => {
    const clip = clipOf(etlFrames());
    for (const phase of ['setup', 'contact', 'finish'] as Phase[]) {
      const f = phaseFrame(clip, phase);
      expect(f, phase).toBeDefined();
      expect(f?.imageUrl, phase).toBeDefined();
    }
  });

  it('uses the ends of the span for setup and finish, contact for contact', () => {
    const clip = clipOf(etlFrames());
    expect(phaseFrame(clip, 'setup')?.offsetContactMs).toBe(-1500);
    expect(phaseFrame(clip, 'contact')?.offsetContactMs).toBe(0);
    expect(phaseFrame(clip, 'finish')?.offsetContactMs).toBe(1500);
  });

  it('prefers a human tag over the guess', () => {
    const frames = etlFrames();
    frames[5] = { ...frames[5], phase: 'contact' };
    expect(phaseFrame(clipOf(frames), 'contact')?.offsetContactMs).toBe(1000);
  });

  it('falls back to the midpoint when the ETL gave no contact offset', () => {
    // Seeded clips carry no `offsetContactMs`.
    const frames = etlFrames().map(({ offsetContactMs: _drop, ...rest }) => rest);
    expect(phaseFrame(clipOf(frames), 'contact')?.i).toBe(3);
  });

  it('returns nothing for a clip with no frames at all', () => {
    expect(phaseFrame(clipOf([]), 'contact')).toBeUndefined();
  });
});

describe('the downloaded clip filename', () => {
  it('keeps the session in the name', () => {
    // `clip.id` carries the session and the swing. A browser reads the slash
    // as a path separator and saves plain `swing_001`, so every session's
    // downloads land on the same handful of names.
    expect(clipFileName('IMG_0305/swing_001', '/api/media/IMG_0305/swings/swing_001/clip.mp4')).toBe(
      'IMG_0305_swing_001.mp4',
    );
  });

  it('takes the extension from the URL', () => {
    // The ETL emits .mp4 or .webm depending on the source, so the extension
    // cannot be assumed.
    expect(clipFileName('a/b', '/base/clip.webm')).toBe('a_b.webm');
  });

  it('appends nothing when the URL has no extension', () => {
    // Better a name with no suffix than one that lies about the container.
    expect(clipFileName('a/b', '/base/clip')).toBe('a_b');
    expect(clipFileName('a/b', '/base.v2/clip')).toBe('a_b');
  });
});
