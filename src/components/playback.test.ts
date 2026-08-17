import { describe, expect, it } from 'vitest';
import type { Clip } from '@/domain/types';
import type { EtlSwingDoc } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import { elapsedLabel, scrubberPercent } from './playback';

const real = (): Clip => adaptSwing(realSwing as unknown as EtlSwingDoc);

describe('scrubberPercent', () => {
  it('clamps a stale frame index from a longer clip to 100%', () => {
    // Both unreachable at 9 frames per clip and live at 49: a selection made on
    // a 49-frame clip, carried onto a 9-frame one, rendered `width: 117%` and
    // overflowed the track.
    expect(scrubberPercent(49, 42)).toBe(100);
    expect(scrubberPercent(11, 9)).toBe(100);
  });

  it('never goes below zero', () => {
    expect(scrubberPercent(-3, 49)).toBe(0);
  });

  it('is the real fraction in between', () => {
    expect(scrubberPercent(25, 49)).toBe(51);
    expect(scrubberPercent(49, 49)).toBe(100);
    expect(scrubberPercent(1, 49)).toBe(2);
  });

  it('does not divide by zero on a clip with no frames', () => {
    expect(scrubberPercent(1, 0)).toBe(0);
  });
});

describe('elapsedLabel', () => {
  it('pads the seconds instead of running the digits together', () => {
    // The old `0:0${frameNum / 4}` hardcoded one digit, so frames 38-49 of a
    // real clip rendered as `0:010`, `0:011`, `0:012`.
    const clip = real();
    for (const i of [37, 41, 45, 48]) {
      expect(elapsedLabel(clip, i)).toMatch(/^\d+:[0-5]\d$/);
    }
  });

  it('derives the clock from the frame’s own ETL timing', () => {
    // 33 ms per frame from the first still, not a 4 fps guess: frame 0 is 0:00
    // and frame 48 is 1600 ms in, which is 0:02 to the nearest second.
    const clip = real();
    // Real fixture offsets: frame 0 is -800 ms from contact, frame 48 is +800,
    // so elapsed runs 0 -> 1600 ms across the clip.
    expect(elapsedLabel(clip, 0)).toBe('0:00');
    expect(elapsedLabel(clip, 15)).toBe('0:00'); // 500 ms — floored, not rounded
    expect(elapsedLabel(clip, 30)).toBe('0:01'); // 1000 ms
    expect(elapsedLabel(clip, 48)).toBe('0:01'); // 1600 ms
  });

  it('rolls over into minutes correctly', () => {
    const clip: Clip = {
      ...real(),
      frames: [
        { i: 0, sourceMs: 0, offsetContactMs: 0, phase: null },
        { i: 1, sourceMs: 61_000, offsetContactMs: 61_000, phase: null },
        { i: 2, sourceMs: 125_000, offsetContactMs: 125_000, phase: null },
      ],
    };
    expect(elapsedLabel(clip, 1)).toBe('1:01');
    expect(elapsedLabel(clip, 2)).toBe('2:05');
  });

  it('falls back to sourceMs for a seeded clip with no ETL timing', () => {
    const clip: Clip = {
      ...real(),
      frames: Array.from({ length: 9 }, (_, i) => ({ i, sourceMs: i * 33, phase: null })),
    };
    expect(clip.frames[0].offsetContactMs).toBeUndefined();
    expect(elapsedLabel(clip, 8)).toBe('0:00');
  });

  it('clamps a stale index rather than reading past the end', () => {
    const clip = real();
    expect(elapsedLabel(clip, 999)).toBe(elapsedLabel(clip, clip.frames.length - 1));
    expect(elapsedLabel({ ...clip, frames: [] }, 3)).toBe('0:00');
  });
});
