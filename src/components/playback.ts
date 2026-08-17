import type { Clip } from '@/domain/types';

/**
 * The detail view's scrubber and clock.
 *
 * Kept out of `DetailView.tsx` so that file exports only its component — a
 * module mixing components and plain functions breaks React Fast Refresh, and
 * these two are the parts worth testing directly.
 */

/**
 * Scrubber fill, as a whole percent clamped to [0, 100].
 *
 * `selectedFrame` is an index into whichever clip the selection was made on, and
 * a stale one from a longer clip overflowed the track — observed at `width: 117%`
 * once clips carried 49 frames instead of 9. The store resets the selection when
 * the detail target changes, so this is the second line of defence, not the
 * first.
 */
export const scrubberPercent = (frameNum: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((frameNum / total) * 100)));
};

/**
 * The playback clock, as `m:ss`.
 *
 * Derived from the frame's own timing where the ETL supplies it:
 * `offsetContactMs` is signed from contact, so elapsed time into the clip is
 * that offset measured from the first frame's. Seeded clips carry no such
 * timing, so they fall back to `sourceMs`, which the seed spaces at a nominal
 * 30 fps.
 *
 * The old `0:0${frameNum / 4}` hardcoded a single digit and a 4 fps guess, so
 * frames 38-49 of a real clip rendered as `0:010`, `0:011`, `0:012`.
 */
export function elapsedLabel(clip: Clip, frameIndex: number): string {
  const frames = clip.frames;
  if (frames.length === 0) return '0:00';
  const frame = frames[Math.max(0, Math.min(frameIndex, frames.length - 1))];
  const first = frames[0];
  const ms =
    frame.offsetContactMs !== undefined && first.offsetContactMs !== undefined
      ? frame.offsetContactMs - first.offsetContactMs
      : frame.sourceMs - first.sourceMs;
  // Floor, not round: a playback clock counts seconds elapsed, so it must not
  // read 0:01 half a second in. Same convention as `formatDuration` in `etl.ts`.
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
