import { describe, expect, it } from 'vitest';
import type { Clip } from '@/domain/types';
import {
  SHORTCUTS,
  SPEED_STEPS,
  axisTicks,
  clock,
  nearestSwing,
  outsideWindow,
  playWindow,
  rateLabel,
  remainingMs,
  stepSpeed,
  timelinePercent,
  windowProgress,
  windowsFor,
  type SwingWindow,
} from './source-playback';

const win = (over: Partial<SwingWindow> = {}): SwingWindow => ({
  id: 'IMG_0684/swing_001',
  startMs: 10000,
  endMs: 13500,
  ...over,
});

describe('playWindow', () => {
  const DURATION = 501582;

  it('is the metadata window when unpadded — per swing, not a fixed length', () => {
    // The whole point: two swings of different lengths keep their own.
    expect(playWindow(win(), DURATION)).toEqual({ startMs: 10000, endMs: 13500 });
    expect(playWindow(win({ startMs: 20000, endMs: 21200 }), DURATION)).toEqual({
      startMs: 20000,
      endMs: 21200,
    });
  });

  it('widens both ends by the pad', () => {
    // The answer to a mis-detected window: widen it, do not re-run the pipeline.
    expect(playWindow(win(), DURATION, 2)).toEqual({ startMs: 8000, endMs: 15500 });
  });

  it('clamps a pad that would run before the start of the video', () => {
    // `currentTime = -0.5` is silently coerced to 0, so an unclamped negative
    // start reads as "the seek worked" while playing the wrong moment.
    expect(playWindow(win({ startMs: 500, endMs: 4000 }), DURATION, 4)).toEqual({
      startMs: 0,
      endMs: 8000,
    });
  });

  it('clamps a pad that would run past the end of the video', () => {
    // Past the duration, `currentTime` seeks to the end and fires `ended` —
    // which would read as "this swing is over" the instant it was selected.
    expect(playWindow(win({ startMs: 499000, endMs: 501000 }), DURATION, 4)).toEqual({
      startMs: 495000,
      endMs: DURATION,
    });
  });

  it('collapses rather than inverting when the window starts past the video', () => {
    const got = playWindow(win({ startMs: 600000, endMs: 603500 }), DURATION);
    expect(got).toEqual({ startMs: DURATION, endMs: DURATION });
    expect(got.endMs).toBeGreaterThanOrEqual(got.startMs);
  });

  it('treats a negative pad as none', () => {
    expect(playWindow(win(), DURATION, -5)).toEqual({ startMs: 10000, endMs: 13500 });
  });

  it('survives a zero-duration video without inverting', () => {
    expect(playWindow(win(), 0)).toEqual({ startMs: 0, endMs: 0 });
  });
});

describe('windowProgress', () => {
  it('runs 0 to 1 across the window', () => {
    expect(windowProgress(10000, 10000, 13500)).toBe(0);
    expect(windowProgress(13500, 10000, 13500)).toBe(1);
    expect(windowProgress(11750, 10000, 13500)).toBeCloseTo(0.5);
  });

  it('clamps outside the window, so scrubbing past it cannot overflow the bar', () => {
    // The reviewer is free to keep playing past the window — that is the
    // feature — and the fill must not render at 117% when they do.
    expect(windowProgress(9000, 10000, 13500)).toBe(0);
    expect(windowProgress(20000, 10000, 13500)).toBe(1);
  });

  it('reads a zero-length window as complete rather than dividing by zero', () => {
    expect(windowProgress(10000, 10000, 10000)).toBe(1);
  });
});

describe('nearestSwing', () => {
  const windows = [win({ startMs: 10000 }), win({ startMs: 20000 }), win({ startMs: 40000 })];

  it('finds the closest by start time', () => {
    expect(nearestSwing(windows, 10100)).toBe(0);
    expect(nearestSwing(windows, 19000)).toBe(1);
    expect(nearestSwing(windows, 39000)).toBe(2);
  });

  it('picks the earlier swing on a tie, so a click lands on the tick clicked', () => {
    expect(nearestSwing(windows, 15000)).toBe(0);
  });

  it('clamps to the ends rather than running off them', () => {
    expect(nearestSwing(windows, 0)).toBe(0);
    expect(nearestSwing(windows, 999999)).toBe(2);
  });

  it('is -1 for a session with no swings, not a swing that does not exist', () => {
    expect(nearestSwing([], 5000)).toBe(-1);
  });
});

describe('clock', () => {
  it('floors to whole seconds — an elapsed clock must not read ahead', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(1999)).toBe('0:01');
    expect(clock(61000)).toBe('1:01');
    expect(clock(501582)).toBe('8:21');
  });

  it('floors to a tenth in the decimal form', () => {
    expect(clock(3190, true)).toBe('0:03.1');
    expect(clock(63990, true)).toBe('1:03.9');
  });

  it('pads the seconds below ten in both forms', () => {
    expect(clock(65000)).toBe('1:05');
    expect(clock(65000, true)).toBe('1:05.0');
  });

  it('floors a negative to zero rather than printing a negative clock', () => {
    expect(clock(-500)).toBe('0:00');
  });
});

describe('timelinePercent', () => {
  it('places a moment along the track', () => {
    expect(timelinePercent(0, 1000)).toBe(0);
    expect(timelinePercent(500, 1000)).toBe(50);
    expect(timelinePercent(1000, 1000)).toBe(100);
  });

  it('clamps a swing that outlives its video', () => {
    // Measured: the proxy runs 501583ms where the probed source says 501581ms,
    // which unclamped put a tick at 100.0004% — outside its own track.
    expect(timelinePercent(501583, 501581)).toBe(100);
  });

  it('is 0 for a video of unknown length rather than NaN', () => {
    expect(timelinePercent(5000, 0)).toBe(0);
  });
});

describe('windowsFor', () => {
  const clip = (over: Partial<Clip>): Clip => ({
    id: 'x',
    player: 'left',
    stroke: null,
    rejected: false,
    duration: '0:03',
    triaged: false,
    grade: null,
    note: '',
    frames: [],
    ...over,
  });

  it('carries the metadata window and contact through', () => {
    const got = windowsFor([
      clip({ id: 'a', sourceStartMs: 10000, sourceEndMs: 13500, contactMs: 11750 }),
    ]);
    expect(got).toEqual([{ id: 'a', startMs: 10000, endMs: 13500, contactMs: 11750 }]);
  });

  it('sorts by start time, so the timeline ticks ascend', () => {
    const got = windowsFor([
      clip({ id: 'late', sourceStartMs: 40000, sourceEndMs: 43500 }),
      clip({ id: 'early', sourceStartMs: 10000, sourceEndMs: 13500 }),
    ]);
    expect(got.map((w) => w.id)).toEqual(['early', 'late']);
  });

  it('drops a clip with no source timing instead of defaulting it to zero', () => {
    // Seeded clips came from no video; a 0-3500 window would put a tick at the
    // head of a timeline they do not belong to.
    expect(windowsFor([clip({ id: 'seeded' })])).toEqual([]);
  });

  it('omits contactMs rather than writing undefined into the window', () => {
    const [got] = windowsFor([clip({ id: 'a', sourceStartMs: 1, sourceEndMs: 2 })]);
    expect('contactMs' in got).toBe(false);
  });
});

describe('axisTicks', () => {
  it('steps by a round interval a person reads as time', () => {
    // 7 minutes over ~8 labels wants 52s, which rounds up to the minute.
    const ticks = axisTicks(7 * 60_000, 8);
    expect(ticks.slice(0, 4)).toEqual([0, 60_000, 120_000, 180_000]);
  });

  it('always starts at zero and ends at the exact duration', () => {
    const ticks = axisTicks(423_000);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(423_000);
  });

  it('widens the step for a long video instead of crowding the axis', () => {
    const short = axisTicks(60_000);
    const long = axisTicks(3 * 3_600_000);
    expect(long[1] - long[0]).toBeGreaterThan(short[1] - short[0]);
    expect(long.length).toBeLessThan(14);
  });

  it('drops an interval tick that would collide with the duration label', () => {
    // 61s: the 60s tick sits a second from the end, which at any real width
    // renders as two labels on top of each other.
    const ticks = axisTicks(61_000, 6);
    expect(ticks).not.toContain(60_000);
    expect(ticks[ticks.length - 1]).toBe(61_000);
  });

  it('drops a tick close enough to the end to touch it, not just overlap it', () => {
    // Observed on IMG_0694 (5:18): 5:00 and 5:18 are 18s apart — far enough not
    // to overlap in time, close enough that the rendered labels collided.
    const ticks = axisTicks(318_000);
    expect(ticks).not.toContain(300_000);
    expect(ticks[ticks.length - 1]).toBe(318_000);
    expect(ticks[ticks.length - 2]).toBe(240_000);
  });

  it('keeps the ticks ascending and inside the video', () => {
    const ticks = axisTicks(501_582);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(501_582);
  });

  it('has nothing to label for a video of unknown length', () => {
    expect(axisTicks(0)).toEqual([]);
    expect(axisTicks(-5)).toEqual([]);
  });
});

describe('remainingMs', () => {
  it('counts down to the window end', () => {
    expect(remainingMs(24_500, 24_500, 28_000)).toBe(3_500);
    expect(remainingMs(27_900, 24_500, 28_000)).toBe(100);
  });

  it('floors at zero rather than reporting negative time left', () => {
    // The boundary overshoots by up to ~150ms on the timeupdate path, so the
    // cursor is routinely PAST the end by the time this is read.
    expect(remainingMs(28_154, 24_500, 28_000)).toBe(0);
  });

  it('reports the whole window before it has started, not the end timestamp', () => {
    // The bug this exists to prevent: the element reports currentTime 0 until a
    // swing is played, and `endMs - 0` rendered a 3.5s window at 0:23.4-0:26.9
    // as "26.9s left" — the window's END POSITION labelled as a duration.
    expect(remainingMs(0, 23_400, 26_900)).toBe(3_500);
    expect(remainingMs(10_000, 23_400, 26_900)).toBe(3_500);
  });

  it('never exceeds the window length', () => {
    expect(remainingMs(0, 400_000, 403_500)).toBe(3_500);
  });

  it('is zero for a window with no length', () => {
    expect(remainingMs(0, 28_000, 28_000)).toBe(0);
  });
});

describe('outsideWindow', () => {
  it('is false inside the window', () => {
    expect(outsideWindow(25_000, 24_500, 28_000)).toBe(false);
    expect(outsideWindow(24_500, 24_500, 28_000)).toBe(false);
  });

  it('is true before the window — the session-switch case', () => {
    // The element reloads to 0 while the selection survives; play from there
    // ran a full minute before reaching the selected window's end.
    expect(outsideWindow(0, 63_000, 66_500)).toBe(true);
  });

  it('treats the end as outside, so resuming there restarts the window', () => {
    expect(outsideWindow(28_000, 24_500, 28_000)).toBe(true);
    expect(outsideWindow(30_000, 24_500, 28_000)).toBe(true);
  });
});

describe('stepSpeed', () => {
  it('steps down and up through the rates', () => {
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(0.75, -1)).toBe(0.5);
    expect(stepSpeed(1, 1)).toBe(1.5);
  });

  it('clamps at both ends rather than wrapping', () => {
    // Holding `<` to reach the slowest rate should arrive and stay, not roll
    // over to 2x and throw away the frame being studied.
    expect(stepSpeed(0.1, -1)).toBe(0.1);
    expect(stepSpeed(2, 1)).toBe(2);
  });

  it('resolves an unknown rate to the nearest step, not to 1x', () => {
    // 0.35 was the old fixed slow rate and can still be in a persisted state.
    expect(stepSpeed(0.35, 0)).toBe(0.25);
    expect(stepSpeed(0.35, 1)).toBe(0.5);
  });

  it('keeps every step a rate a browser will actually play', () => {
    // Chrome mutes below 0.0625 and stutters near it; contact sound is part of
    // what is being judged.
    for (const r of SPEED_STEPS) expect(r).toBeGreaterThanOrEqual(0.1);
  });
});

describe('rateLabel', () => {
  it('trims trailing zeros so the badge stays narrow', () => {
    expect(rateLabel(1)).toBe('1×');
    expect(rateLabel(0.5)).toBe('0.5×');
    expect(rateLabel(0.25)).toBe('0.25×');
    expect(rateLabel(1.5)).toBe('1.5×');
  });
});

describe('SHORTCUTS', () => {
  it('registers the labelling keys, so the help overlay cannot go stale', () => {
    // The list exists precisely so the handler, the button labels and the `?`
    // overlay cannot drift apart. A key bound in `KeyframeReview` and missing
    // here is a key nothing tells the reviewer about.
    const ball = SHORTCUTS.filter((k) => k.mode === 'ball').map((k) => k.what);

    expect(SHORTCUTS.some((k) => k.label === 'b' && k.mode === undefined)).toBe(true);
    expect(ball).toContain('Accept the offered candidate');
    expect(ball).toContain('No ball visible in this frame');
    expect(ball).toContain('Put the ball where it really is');
    expect(ball).toContain('Unlabel this frame');
  });

  it('says the arrows are REBOUND while labelling rather than listing them once', () => {
    // Two entries with the same key and different meanings is the honest
    // description of a mode, and the overlay groups them under a heading.
    const arrows = SHORTCUTS.filter((k) => k.label === '\u2190 \u2192');

    expect(arrows).toHaveLength(2);
    expect(arrows.filter((k) => k.mode === 'ball')).toHaveLength(1);
  });
});
