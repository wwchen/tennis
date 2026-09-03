import type { Clip } from '@/domain/types';

/**
 * Playing one swing out of the whole source video.
 *
 * The app used to hand `<video>` a `clip.mp4` cut to the detector's window, so
 * the window WAS the file: a swing detected 400ms late had its contact cut off,
 * and no amount of scrubbing could recover it — those frames were not in the
 * file. Here the element holds the entire session and a swing is a pair of
 * timestamps into it, so a wrong window costs a keypress rather than a re-render.
 *
 * Everything below is pure, so the boundary arithmetic can be tested without a
 * media element — which in jsdom neither decodes nor advances `currentTime`.
 */

/** A swing as the player addresses it: an interval in source-video time. */
export interface SwingWindow {
  id: string;
  startMs: number;
  endMs: number;
  /** The detector's contact moment, for the marker inside the window. */
  contactMs?: number;
}

/** Seconds of slack the UI can add to BOTH ends of every window. */
export const PAD_STEPS = [0, 0.5, 1, 2, 4] as const;

/**
 * The interval to play for a swing, padded and clamped to the video.
 *
 * `padS` widens both ends, which is the direct answer to a mis-detected
 * window: the reviewer widens it rather than re-running the pipeline. Clamping
 * to `[0, durationMs]` matters because `currentTime = -0.5` is silently coerced
 * to 0, while a `currentTime` past the duration seeks to the end and fires
 * `ended` — which would read as "this swing is over" the instant it was picked.
 *
 * A window starting at or past the end of the video collapses onto the last
 * instant rather than inverting: an empty interval the caller can still seek
 * to, instead of a negative-length one it cannot.
 */
export function playWindow(
  win: SwingWindow,
  durationMs: number,
  padS = 0,
): { startMs: number; endMs: number } {
  const pad = Math.max(0, padS) * 1000;
  const limit = Math.max(0, durationMs);
  const startMs = Math.min(Math.max(0, win.startMs - pad), limit);
  const endMs = Math.min(Math.max(startMs, win.endMs + pad), limit);
  return { startMs, endMs };
}

/**
 * How far through its window playback has reached, as a 0-1 fraction.
 *
 * A zero-length window reads as complete rather than dividing by zero: there is
 * nothing left of it to play.
 */
export function windowProgress(cursorMs: number, startMs: number, endMs: number): number {
  const span = endMs - startMs;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (cursorMs - startMs) / span));
}

/**
 * The swing nearest a point in the video, by start time.
 *
 * What a click on the source timeline resolves to. Ties go to the earlier
 * swing — the one drawn first — so clicking a tick selects the tick that was
 * clicked rather than its neighbour.
 *
 * Returns -1 for an empty list: a session with no swings has nothing to select,
 * and 0 would name a swing that does not exist.
 */
export function nearestSwing(windows: SwingWindow[], ms: number): number {
  if (windows.length === 0) return -1;
  let best = 0;
  let bestGap = Math.abs(windows[0].startMs - ms);
  for (let i = 1; i < windows.length; i++) {
    const gap = Math.abs(windows[i].startMs - ms);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * `m:ss`, or `m:ss.d` with `decimals`.
 *
 * Floored, matching `formatDuration` in `etl.ts` and `elapsedLabel` in
 * `playback.ts`: a clock counting elapsed time must not read 0:01 half a second
 * in. The one-decimal form is for the window readout, where swings are a few
 * seconds long and whole seconds cannot tell two of them apart.
 */
export function clock(ms: number, decimals = false): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const rest = total - m * 60;
  if (!decimals) return `${m}:${String(Math.floor(rest)).padStart(2, '0')}`;
  // Floored to a tenth, for the same reason: 3.19s is 3.1 elapsed, not 3.2.
  const tenths = Math.floor(rest * 10) / 10;
  return `${m}:${tenths < 10 ? '0' : ''}${tenths.toFixed(1)}`;
}

/**
 * Where a moment sits along the source timeline, as a CSS percentage.
 *
 * Clamped, because a swing can outlive its video: `duration_ms` comes from
 * `ffprobe` on the source, and the proxy's own duration can differ by a frame
 * or two (measured: 501583ms against 501581ms). Unclamped, that put a tick at
 * `100.0004%` — outside the track it was positioned in.
 */
export function timelinePercent(ms: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.max(0, Math.min(100, (ms / durationMs) * 100));
}

/**
 * The windows for a session's clips, in source order.
 *
 * A clip with no source timing is dropped rather than defaulted: it came from
 * the seed, which has no video behind it, and inventing `0-3500` for it would
 * put a tick at the head of a timeline it does not belong to.
 */
export function windowsFor(clips: Clip[]): SwingWindow[] {
  const windows: SwingWindow[] = [];
  for (const clip of clips) {
    if (clip.sourceStartMs === undefined || clip.sourceEndMs === undefined) continue;
    windows.push({
      id: clip.id,
      startMs: clip.sourceStartMs,
      endMs: clip.sourceEndMs,
      ...(clip.contactMs === undefined ? {} : { contactMs: clip.contactMs }),
    });
  }
  return windows.sort((a, b) => a.startMs - b.startMs);
}
