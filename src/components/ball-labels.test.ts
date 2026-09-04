import { describe, expect, it } from 'vitest';
import {
  BALL_LABELS_SCHEMA,
  ballLabelsDoc,
  centreOf,
  firstFrameOf,
  labelKey,
  lastPosition,
  nearestFrame,
  parseBallCandidates,
  parseBallLabels,
  pickCandidate,
  pointRect,
  sourcePoint,
  windowAt,
  windowProgress,
  type BallLabels,
} from './ball-labels';
import type { BoxRow, ObjectsFrame } from './object-overlay';

/** The candidate export's first line, cut down from the real one. */
const HEADER =
  '{"space": "source_display", "detector": "yolo/coco", "weights": "yolo11x.pt", ' +
  '"imgsz": 1280, "conf": 0.1, "fps": 0, "width": 1080, "height": 1920, ' +
  '"windows": [[28943, 29943], [82666, 83666]], "contacts": [29443, 83166]}';

/** Two real frame lines, one of them with no detection at all. */
const FRAMES =
  '{"ms": 28933, "ball": [[380.6, 877.6, 25.5, 24.4, 0.215], [380.0, 877.0, 52.6, 28.8, 0.129]]}\n' +
  '{"ms": 29033}';

const frame = (ms: number, ball?: BoxRow[]): ObjectsFrame =>
  ball === undefined ? { ms } : { ms, ball };

describe('parseBallCandidates', () => {
  it('carries the labelling windows, paired with their contact times', () => {
    const doc = parseBallCandidates(`${HEADER}\n${FRAMES}\n`);

    expect(doc?.header.windows).toEqual([
      { startMs: 28943, endMs: 29943, contactMs: 29443 },
      { startMs: 82666, endMs: 83666, contactMs: 83166 },
    ]);
    // `fps: 0` is the file's way of saying "native rate, and windowed", and it
    // has to survive: nothing can be inferred about the sampling interval.
    expect(doc?.header.fps).toBe(0);
    expect(doc?.header.width).toBe(1080);
  });

  it('keeps a frame that has no detection, rather than dropping it', () => {
    // A frame with no ball is exactly the frame a human has to look at and say
    // "no ball here". Dropping it would make that label unreachable.
    const doc = parseBallCandidates(`${HEADER}\n${FRAMES}\n`);

    expect(doc?.frames).toHaveLength(2);
    expect(doc?.frames[1]).toEqual({ ms: 29033 });
    expect(doc?.frames[0].ball).toHaveLength(2);
  });

  it('keeps the frames before a truncated last line', () => {
    // The export runs for minutes of GPU time and is written as it goes, so a
    // half-written final line is its ordinary state while it is being produced.
    const doc = parseBallCandidates(`${HEADER}\n${FRAMES}\n{"ms": 29050, "ball": [[1,2,`);

    expect(doc?.frames).toHaveLength(2);
  });

  it('collapses a header naming no windows onto one span over the frames', () => {
    const noWindows = HEADER.replace('"windows": [[28943, 29943], [82666, 83666]], ', '');
    const doc = parseBallCandidates(`${noWindows}\n${FRAMES}`);

    expect(doc?.header.windows).toEqual([{ startMs: 28933, endMs: 29033 }]);
  });

  it('returns null for a header with no frame size to scale against', () => {
    expect(parseBallCandidates('{"fps": 0}\n{"ms": 1}')).toBeNull();
  });
});

describe('parseBallLabels', () => {
  it('round-trips a document through JSON unchanged', () => {
    const doc = ballLabelsDoc('IMG_0684', { '79733': [843, 982], '79750': null });

    expect(parseBallLabels(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(doc.schema).toBe(BALL_LABELS_SCHEMA);
    expect(doc.space).toBe('source_display');
  });

  it('keeps a null apart from an absent key', () => {
    // The whole point of the file: `null` is "a human looked and there is no
    // ball", an absent key is "nobody has looked". Conflating them would make
    // every missed ball indistinguishable from an unlabelled frame.
    const doc = parseBallLabels({
      schema: BALL_LABELS_SCHEMA,
      session: 'IMG_0684',
      space: 'source_display',
      labels: { '79750': null },
    });

    expect(doc?.labels).toHaveProperty('79750');
    expect(doc?.labels['79750']).toBeNull();
    expect(doc?.labels['79766']).toBeUndefined();
  });

  it('is keyed by source timestamp, never by swing id', () => {
    // Swing numbering is not stable: re-running detection renumbers every
    // `swings/swing_NNN`, which has already orphaned a set of human verdicts
    // once in this project. A key that is not a timestamp is dropped rather
    // than kept as a label nothing can ever be joined to.
    const doc = parseBallLabels({
      schema: BALL_LABELS_SCHEMA,
      session: 'IMG_0684',
      space: 'source_display',
      labels: { swing_005: [1, 2], '79733': [843, 982] },
    });

    expect(Object.keys(doc?.labels ?? {})).toEqual(['79733']);
  });

  it('drops an unreadable entry and keeps the rest', () => {
    const doc = parseBallLabels({
      schema: BALL_LABELS_SCHEMA,
      session: 'IMG_0684',
      space: 'source_display',
      labels: { '1': [1], '2': ['a', 'b'], '3': [Infinity, 2], '4': [10, 20] },
    });

    expect(doc?.labels).toEqual({ '4': [10, 20] });
  });

  it('refuses a document from another schema or another coordinate space', () => {
    const base = { session: 'IMG_0684', space: 'source_display', labels: {} };

    expect(parseBallLabels({ ...base, schema: 'tennis.ball-labels/2' })).toBeNull();
    expect(parseBallLabels({ ...base, schema: BALL_LABELS_SCHEMA, space: 'crop' })).toBeNull();
    expect(parseBallLabels(null)).toBeNull();
    expect(parseBallLabels([])).toBeNull();
  });
});

describe('labelKey', () => {
  it('is the whole-millisecond timestamp, so one frame has exactly one key', () => {
    expect(labelKey(79733)).toBe('79733');
    expect(labelKey(79733.4)).toBe('79733');
    expect(labelKey(79732.6)).toBe('79733');
  });
});

describe('pickCandidate', () => {
  // Two boxes: a confident one far away and a faint one right where the ball
  // was. This is the shape of the real problem — 73% of frames carry a
  // detection but only 8.5% of them move, so the confident box is usually a
  // dead ball lying on the court.
  const still: BoxRow = [100, 100, 20, 20, 0.9];
  const flying: BoxRow = [500, 500, 20, 20, 0.2];

  it('offers the candidate nearest the last accepted position, not the surest', () => {
    expect(pickCandidate([still, flying], [505, 505])).toBe(1);
  });

  it('falls back to the surest box on the first frame, where there is no previous', () => {
    expect(pickCandidate([still, flying], null)).toBe(0);
  });

  it('has nothing to offer for a frame with no detections', () => {
    expect(pickCandidate([], [1, 1])).toBe(-1);
  });
});

describe('lastPosition', () => {
  const frames = [frame(100), frame(200), frame(300), frame(400)];

  it('walks back past a "no ball" label to the last real position', () => {
    // A null says nothing about where the ball is, so anchoring the next
    // candidate choice on it would be anchoring on nothing.
    const labels: BallLabels = { '100': [10, 10], '200': null, '300': null };

    expect(lastPosition(frames, 3, labels)).toEqual([10, 10]);
  });

  it('is null when nothing before this frame has been labelled', () => {
    expect(lastPosition(frames, 2, { '300': [1, 1] })).toBeNull();
  });
});

describe('windowProgress', () => {
  const frames = [frame(100), frame(200), frame(300), frame(999)];
  const window = { startMs: 100, endMs: 300 };

  it('counts a "no ball" as done, because it is a call a human made', () => {
    expect(windowProgress(frames, window, { '100': [1, 1], '200': null })).toEqual({
      labelled: 2,
      total: 3,
    });
  });

  it('counts only the frames inside the window', () => {
    expect(windowProgress(frames, window, { '999': [1, 1] })).toEqual({ labelled: 0, total: 3 });
  });
});

describe('windowAt / nearestFrame / firstFrameOf', () => {
  const windows = [
    { startMs: 100, endMs: 200 },
    { startMs: 900, endMs: 1000 },
  ];
  const frames = [frame(100), frame(200), frame(900), frame(1000)];

  it('finds the window a frame belongs to, ends included', () => {
    expect(windowAt(windows, 200)).toBe(0);
    expect(windowAt(windows, 900)).toBe(1);
    expect(windowAt(windows, 500)).toBe(-1);
  });

  it('lands on the nearest frame, not the one before, for a playhead in a gap', () => {
    // At-or-before would put a reviewer who paused just short of a window at
    // the end of the previous one, minutes of video away from what they were
    // watching.
    expect(nearestFrame(frames, 880)).toBe(2);
    expect(nearestFrame(frames, 210)).toBe(1);
    expect(nearestFrame([], 0)).toBe(-1);
  });

  it('finds the first frame of a window', () => {
    expect(firstFrameOf(frames, windows[1])).toBe(2);
    expect(firstFrameOf(frames, { startMs: 400, endMs: 500 })).toBe(-1);
  });
});

describe('centreOf', () => {
  it('is the middle of the box, which is what a label records', () => {
    expect(centreOf([100, 200, 20, 40, 0.5])).toEqual([110, 220]);
  });
});

describe('sourcePoint', () => {
  // A portrait source in a wide stage: the picture is 300x533 inside a 500px
  // element, so 100px of letterbox sits either side of it.
  const content = { left: 100, top: 0, width: 300, height: 533 };
  const header = { width: 1080, height: 1920 };

  it('takes the letterbox offset off before scaling to source pixels', () => {
    const point = sourcePoint(250, 266.5, content, header);

    expect(point?.[0]).toBeCloseTo(540, 1);
    expect(point?.[1]).toBeCloseTo(960, 1);
  });

  it('records nothing for a click on the letterbox bars', () => {
    // Clamping instead would file a ball pinned to the edge of the frame — a
    // position no human meant, and one they have no way of seeing is wrong.
    expect(sourcePoint(40, 200, content, header)).toBeNull();
    expect(sourcePoint(460, 200, content, header)).toBeNull();
  });

  it('is the inverse of pointRect, so a click lands back where it was drawn', () => {
    const point = sourcePoint(310, 400, content, header);
    const rect = pointRect(point ?? [0, 0], content, header);

    expect(rect.left).toBeCloseTo(310, 6);
    expect(rect.top).toBeCloseTo(400, 6);
  });
});
