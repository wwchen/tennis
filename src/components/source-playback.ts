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

/**
 * The intervals an axis is allowed to step by, in ms.
 *
 * Round numbers a person reads as time: quarter-minutes up to a minute, then
 * whole and half minutes, then five and ten. An axis stepping by 47s is
 * arithmetically fine and useless to read.
 */
const AXIS_STEPS = [
  5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_800_000, 3_600_000,
];

/**
 * Labelled positions along the source timeline.
 *
 * The axis used to carry three labels: `0:00`, the cursor's time, and the
 * duration — with the cursor's value pinned to the MIDDLE of the row by
 * `space-between` rather than to the cursor. So it read as a midpoint label
 * that was never the midpoint, and next to a red playhead somewhere else
 * entirely it said nothing true about any position on the track.
 *
 * A real axis instead labels fixed intervals, so a tick's distance along the
 * track is proportional to its time and the whole row can be read as a scale.
 * `target` is how many labels to aim for, not a promise: the step is rounded UP
 * to the next round interval, so a 7-minute session gets minutes and an
 * hour-long one gets five-minute marks, both without crowding.
 *
 * The final label is always the exact duration, even when it lands close to the
 * previous tick — the end of the video is the one position a reviewer scrubbing
 * to the last swing needs to see.
 */
export function axisTicks(durationMs: number, target = 8): number[] {
  if (durationMs <= 0) return [];

  const ideal = durationMs / Math.max(1, target);
  const step = AXIS_STEPS.find((s) => s >= ideal) ?? AXIS_STEPS[AXIS_STEPS.length - 1];

  const ticks: number[] = [];
  for (let t = 0; t < durationMs; t += step) ticks.push(t);

  // Drop a last interval tick crowding the duration label. A third of a step is
  // the gap below which the two collide: labels are ~5 characters wide and the
  // duration is right-aligned to the very end, so they meet well before their
  // times do. Measured on a 5:18 session, where 5:00 and 5:18 sit 18s apart and
  // rendered touching at 570px of track.
  if (ticks.length > 1 && durationMs - ticks[ticks.length - 1] < step / 3) ticks.pop();
  ticks.push(durationMs);
  return ticks;
}

/**
 * Milliseconds left in the window, measured from INSIDE it.
 *
 * Surfaced because the UI gave no answer to "when does this stop?" beyond a 3px
 * bar: the window end was enforced but invisible, so a swing playing on read as
 * the app having lost track of the boundary rather than as three seconds still
 * to run.
 *
 * The cursor is clamped into `[startMs, endMs]` rather than subtracted raw,
 * which is the whole fix here. Before a swing has started playing the element
 * still reports `currentTime` 0, so a bare `endMs - cursorMs` returned the
 * window's END TIMESTAMP: a 3.5s window at 0:23.4-0:26.9 read "26.9s left".
 * That is not a rounding error but a different quantity entirely — a position
 * in the source wearing the label of a duration.
 *
 * Clamped, a playhead before the window reports the window's full length (it
 * has all of it still to run) and one past the end reports zero.
 */
export const remainingMs = (cursorMs: number, startMs: number, endMs: number): number => {
  const span = Math.max(0, endMs - startMs);
  const inside = Math.max(startMs, Math.min(cursorMs, endMs));
  return Math.min(span, Math.max(0, endMs - inside));
};

/**
 * Whether the playhead is outside the window that is supposed to be playing.
 *
 * Selecting a swing seeks, so this is normally false — but switching sessions
 * reloads the element to 0 while the selection survives, which left the
 * playhead a minute or more before the selected window. Pressing play then ran
 * from wherever it was until it happened to reach the window's END, so the
 * boundary appeared not to work at all. The caller seeks back in instead.
 *
 * The end is exclusive: a playhead resting exactly on `endMs` has finished the
 * window, and resuming from there should restart it rather than read as inside.
 */
export const outsideWindow = (cursorMs: number, startMs: number, endMs: number): boolean =>
  cursorMs < startMs || cursorMs >= endMs;


/**
 * What happens when playback reaches the end of a swing's window.
 *
 * An explicit three-way choice rather than an auto-advance checkbox, because
 * the checkbox only ever described one of the three and left the other two to
 * be discovered: "off" silently meant stop, and continuing past the boundary
 * was reachable only through a button on a card that appeared after stopping.
 * A reviewer scanning a session and one studying a single shot want different
 * defaults, and neither should have to find that out by experiment.
 */
export const END_MODES = ['stop', 'continue', 'next'] as const;
export type EndMode = (typeof END_MODES)[number];

/** The label and meaning of each mode, for the control and its tooltips. */
export const END_MODE_LABELS: Record<EndMode, { label: string; title: string }> = {
  stop: { label: 'Stop', title: 'Pause at the end of the window' },
  continue: { label: 'Continue', title: 'Keep playing into the rest of the video' },
  next: { label: 'Next', title: 'Advance to the next swing after a countdown' },
};


/**
 * Every keyboard shortcut this view binds, and what it does.
 *
 * One list, used three ways: to label the buttons that have a shortcut, to
 * render the `?` overlay, and as the reference a reader checks the handler
 * against. Keeping them in three hand-synced places is how a UI ends up
 * advertising a key it no longer binds.
 */
export const SHORTCUTS: { label: string; what: string }[] = [
  { label: '\u2190 \u2192', what: 'Previous / next swing' },
  { label: 'space', what: 'Play / pause' },
  { label: 'r', what: 'Replay the window' },
  { label: '< >', what: 'Slower / faster' },
  { label: 's', what: 'Star this swing' },
  { label: 'x', what: 'Hide this swing' },
  { label: 'e', what: 'Export this swing' },
  { label: '?', what: 'This list' },
];

/**
 * Playback rates `<` and `>` step through.
 *
 * Weighted below 1x on purpose: this is a tool for reading a swing, and the
 * question it answers -- where the racket was at contact -- is only legible
 * slowed down. The two rates above 1x exist for moving THROUGH a session rather
 * than studying one shot, which is a different job the same control can do.
 *
 * 0.1 is the floor because Chrome mutes audio below 0.0625 and stutters badly
 * approaching it; the contact sound is part of what a reviewer is judging.
 */
export const SPEED_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;

/**
 * The next rate in `step` direction, clamped at both ends.
 *
 * Clamped rather than wrapped: a reviewer holding `<` to reach the slowest
 * rate should arrive and stay there, not roll over to 2x and lose the frame
 * they were studying.
 */
export function stepSpeed(rate: number, step: number): number {
  const i = SPEED_STEPS.indexOf(rate as (typeof SPEED_STEPS)[number]);
  // An unknown rate (set before these steps existed, say) resolves to the
  // nearest step rather than snapping to 1x and losing the reviewer's place.
  const from =
    i >= 0
      ? i
      : SPEED_STEPS.reduce(
          (best, r, j) => (Math.abs(r - rate) < Math.abs(SPEED_STEPS[best] - rate) ? j : best),
          0,
        );
  return SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, from + step))];
}

/** `1x`, `0.35x`, `0.1x` — trailing zeros trimmed so the badge stays narrow. */
export const rateLabel = (rate: number): string =>
  `${Number(rate.toFixed(2))}\u00d7`;
