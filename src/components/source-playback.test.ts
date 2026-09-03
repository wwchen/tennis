import { describe, expect, it } from 'vitest';
import type { Clip } from '@/domain/types';
import {
  clock,
  nearestSwing,
  playWindow,
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
