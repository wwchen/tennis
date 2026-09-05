import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLASSES,
  DEFAULT_CONF,
  boxRect,
  drawnBoxes,
  frameAt,
  objectsUrl,
  parseObjectsJsonl,
  readOverlayPrefs,
  sampleLifeMs,
  type BoxRow,
  type ObjectClass,
  type ObjectsFrame,
  type ObjectsHeader,
  videoContentRect,
  writeOverlayPrefs,
} from './object-overlay';

/** The first two lines of a real export, verbatim. */
const HEADER =
  '{"space":"source_display","detector":"yolo/coco","weights":"yolo11x.pt",' +
  '"imgsz":1280,"conf":0.1,"fps":10.0,"width":1080,"height":1920}';
const FRAME =
  '{"racket":[[658.0,866.9,61.9,171.0,0.773]],"ball":[[790.2,841.0,18.0,16.9,0.828]],' +
  '"person":[[531.3,865.8,277.6,532.4,0.899]],"ms":76000}';

const header = (over: Partial<ObjectsHeader> = {}): ObjectsHeader => ({
  detector: 'yolo/coco',
  weights: 'yolo11x.pt',
  fps: 10,
  conf: 0.1,
  width: 1080,
  height: 1920,
  ...over,
});

describe('parseObjectsJsonl', () => {
  it('reads the header and one line per sampled frame', () => {
    const doc = parseObjectsJsonl(`${HEADER}\n${FRAME}\n`);

    expect(doc?.header).toEqual(header());
    expect(doc?.frames).toHaveLength(1);
    expect(doc?.frames[0].ms).toBe(76000);
    expect(doc?.frames[0].racket).toEqual([[658.0, 866.9, 61.9, 171.0, 0.773]]);
  });

  it('leaves a class absent when the line omits it, rather than inventing an empty list', () => {
    // The exporter drops a class with no detections from the line entirely, so
    // an empty array here would be a claim the file never made.
    const doc = parseObjectsJsonl(`${HEADER}\n{"racket":[[1,2,3,4,0.5]],"ms":100}`);

    expect(doc?.frames[0].racket).toHaveLength(1);
    expect(doc?.frames[0].ball).toBeUndefined();
    expect(doc?.frames[0].person).toBeUndefined();
  });

  it('keeps the frames before a truncated last line', () => {
    // The export runs for minutes of GPU time and is written as it goes, so a
    // run killed part way through leaves half a line on disk. That file is
    // still worth watching up to where it stops.
    const doc = parseObjectsJsonl(`${HEADER}\n${FRAME}\n{"racket":[[1,2,3,4,0.`);

    expect(doc?.frames).toHaveLength(1);
  });

  it('sorts samples, because the lookup binary-searches them', () => {
    // Presentation times are read back from the decoder on variable-frame-rate
    // footage. One out-of-order sample would make the search skip a range.
    const doc = parseObjectsJsonl(
      `${HEADER}\n{"ball":[[1,2,3,4,0.5]],"ms":300}\n{"ball":[[1,2,3,4,0.5]],"ms":100}`,
    );

    expect(doc?.frames.map((f) => f.ms)).toEqual([100, 300]);
  });

  it('refuses a file with no usable frame size', () => {
    // Without `width` there is nothing to scale against, and drawing the boxes
    // at 1:1 over a video displayed smaller piles them into the top-left corner
    // — which looks like a detector fault rather than a missing header.
    expect(parseObjectsJsonl('')).toBeNull();
    expect(parseObjectsJsonl('not json\n')).toBeNull();
    expect(parseObjectsJsonl('{"detector":"yolo/coco"}\n')).toBeNull();
    expect(parseObjectsJsonl('{"width":0,"height":1920}\n')).toBeNull();
  });
});

describe('frameAt', () => {
  const frames: ObjectsFrame[] = [
    { ms: 1000, racket: [[1, 1, 1, 1, 0.9]] },
    { ms: 1100, racket: [[2, 2, 2, 2, 0.9]] },
    { ms: 1200, racket: [[3, 3, 3, 3, 0.9]] },
  ];
  const life = sampleLifeMs(10);

  it('picks the sample at or before the playhead, never the one after', () => {
    // Drawing the NEXT sample puts the ball where it is about to be, which on
    // the contact frame is the one place it demonstrably is not.
    expect(frameAt(frames, 1150, life)?.ms).toBe(1100);
    expect(frameAt(frames, 1199, life)?.ms).toBe(1100);
  });

  it('takes an exact hit as itself', () => {
    expect(frameAt(frames, 1100, life)?.ms).toBe(1100);
    expect(frameAt(frames, 1000, life)?.ms).toBe(1000);
  });

  it('draws nothing before the first sample', () => {
    expect(frameAt(frames, 999, life)).toBeNull();
    expect(frameAt([], 5000, life)).toBeNull();
  });

  it('lets a sample expire, because a gap in the file means nothing was found', () => {
    // The load-bearing case. `detect_objects.py` omits a frame with no
    // detections entirely, so "nearest at or before" alone keeps a racket on
    // screen for as long as the detector fails to see one — here, 30 seconds
    // after the player walked out of shot.
    expect(frameAt(frames, 1250, life)?.ms).toBe(1200);
    expect(frameAt(frames, 31200, life)).toBeNull();
  });

  it('holds a sample for one and a half sampling intervals', () => {
    // Wide enough to bridge the jitter of a variable-frame-rate source at the
    // 10fps the export samples at; narrow enough that a real gap goes blank.
    expect(sampleLifeMs(10)).toBe(150);
    expect(frameAt(frames, 1200 + 150, life)?.ms).toBe(1200);
    expect(frameAt(frames, 1200 + 151, life)).toBeNull();
  });

  it('falls back to about one frame for a header claiming no rate', () => {
    expect(sampleLifeMs(0)).toBe(100);
  });
});

describe('videoContentRect', () => {
  it('finds the picture inside a letterboxed element', () => {
    // Portrait footage in a wide element: the picture is 405px of a 900px box,
    // so scaling boxes by the ELEMENT's width would put every one of them
    // roughly twice as far right as it belongs.
    expect(
      videoContentRect({
        clientWidth: 900,
        clientHeight: 720,
        videoWidth: 1080,
        videoHeight: 1920,
      }),
    ).toEqual({ left: 247.5, top: 0, width: 405, height: 720 });
  });

  it('is the whole element when the aspect ratios agree', () => {
    expect(
      videoContentRect({
        clientWidth: 540,
        clientHeight: 960,
        videoWidth: 1080,
        videoHeight: 1920,
      }),
    ).toEqual({ left: 0, top: 0, width: 540, height: 960 });
  });

  it('has no answer before the metadata has loaded', () => {
    // Which is also every measurement jsdom makes, so this is the state the
    // component renders in under test.
    expect(
      videoContentRect({ clientWidth: 900, clientHeight: 720, videoWidth: 0, videoHeight: 0 }),
    ).toBeNull();
    expect(
      videoContentRect({ clientWidth: 0, clientHeight: 0, videoWidth: 1080, videoHeight: 1920 }),
    ).toBeNull();
  });
});

describe('boxRect', () => {
  it('scales source-display pixels onto the displayed picture, letterbox included', () => {
    const content = { left: 247.5, top: 0, width: 405, height: 720 };
    // Half size in each axis (405/1080, 720/1920), then shifted by the letterbox.
    expect(boxRect([658, 866.9, 61.9, 171, 0.773] as BoxRow, content, header())).toEqual({
      left: 247.5 + 658 * 0.375,
      top: 866.9 * 0.375,
      width: 61.9 * 0.375,
      height: 171 * 0.375,
    });
  });

  it('scales each axis against its own header dimension', () => {
    // The proxy need not share the source's aspect ratio, so one factor is not
    // enough: a box scaled by width alone would be the wrong height.
    const content = { left: 0, top: 0, width: 1080, height: 960 };
    const r = boxRect([100, 100, 100, 100, 0.9] as BoxRow, content, header());
    expect(r).toEqual({ left: 100, top: 50, width: 100, height: 50 });
  });
});

describe('drawnBoxes', () => {
  const frame: ObjectsFrame = {
    ms: 76000,
    racket: [
      [658, 866.9, 61.9, 171, 0.773],
      // The duplicate the export carries at its own conf 0.10: a second box on
      // the same racket, and a third on court furniture.
      [655, 860, 60, 168, 0.19],
      [40, 1500, 55, 120, 0.12],
    ],
    ball: [[790.2, 841, 18, 16.9, 0.828]],
    person: [[531.3, 865.8, 277.6, 532.4, 0.899]],
  };
  const shown = (...cls: ObjectClass[]) => new Set<ObjectClass>(cls);

  it('drops boxes under the floor, which is most of what a raw export carries', () => {
    const drawn = drawnBoxes(frame, shown('racket'), 0.25);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].box[4]).toBe(0.773);
  });

  it('shows everything on disk at the export’s own floor', () => {
    // The view for "did the detector see it at all", duplicates and furniture
    // included — which is exactly what the file holds.
    expect(drawnBoxes(frame, shown('racket'), 0.1)).toHaveLength(3);
  });

  it('draws only the classes that are switched on', () => {
    expect(drawnBoxes(frame, shown('ball'), 0.25).map((d) => d.cls)).toEqual(['ball']);
    expect(drawnBoxes(frame, shown('racket', 'ball'), 0.25).map((d) => d.cls)).toEqual([
      'racket',
      'ball',
    ]);
    expect(drawnBoxes(frame, shown(), 0.25)).toEqual([]);
  });

  it('draws nothing when there is no sample to draw', () => {
    expect(drawnBoxes(null, shown('racket', 'ball', 'person'), 0)).toEqual([]);
  });
});

describe('objectsUrl', () => {
  it('escapes the session name, which reaches the route as a path segment', () => {
    expect(objectsUrl('IMG_0684')).toBe('/api/objects/IMG_0684');
    expect(objectsUrl('a/b')).toBe('/api/objects/a%2Fb');
  });
});

describe('overlay preferences', () => {
  const store = (raw: string | null) => ({
    getItem: () => raw,
    setItem: () => undefined,
  });

  it('falls back to the defaults when nothing is stored', () => {
    const got = readOverlayPrefs(store(null));
    expect([...got.classes].sort()).toEqual([...DEFAULT_CLASSES].sort());
    expect(got.conf).toBe(DEFAULT_CONF);
  });

  it('restores what was written', () => {
    let held: string | null = null;
    const rw = {
      getItem: () => held,
      setItem: (_k: string, v: string) => {
        held = v;
      },
    };
    writeOverlayPrefs({ classes: new Set<ObjectClass>(['person']), conf: 0.5 }, rw);
    const got = readOverlayPrefs(rw);
    expect([...got.classes]).toEqual(['person']);
    expect(got.conf).toBe(0.5);
  });

  it('keeps an empty class list, which is a real choice', () => {
    // Every class turned off is a reviewer decision, not corruption; only a
    // missing or unparseable list falls back to the defaults.
    const got = readOverlayPrefs(store(JSON.stringify({ classes: [], conf: 0.25 })));
    expect(got.classes.size).toBe(0);
  });

  it('drops a class name that no longer exists rather than blanking the overlay', () => {
    const got = readOverlayPrefs(
      store(JSON.stringify({ classes: ['racket', 'shuttlecock'], conf: 0.25 })),
    );
    expect([...got.classes]).toEqual(['racket']);
  });

  it('rejects a conf off the step scale, which would leave every button unselected', () => {
    expect(readOverlayPrefs(store(JSON.stringify({ conf: 0.37 }))).conf).toBe(DEFAULT_CONF);
    expect(readOverlayPrefs(store(JSON.stringify({ conf: 'high' }))).conf).toBe(DEFAULT_CONF);
  });

  it('survives malformed json and a hostile shape', () => {
    expect(readOverlayPrefs(store('{not json')).conf).toBe(DEFAULT_CONF);
    expect(readOverlayPrefs(store('null')).conf).toBe(DEFAULT_CONF);
    expect(readOverlayPrefs(store('[1,2,3]')).conf).toBe(DEFAULT_CONF);
  });

  it('a storage that throws costs the preference, never the session', () => {
    const hostile = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() =>
      writeOverlayPrefs({ classes: new Set<ObjectClass>(['ball']), conf: 0.1 }, hostile),
    ).not.toThrow();
  });
});
