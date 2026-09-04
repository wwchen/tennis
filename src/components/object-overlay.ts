/**
 * Drawing the object detector's boxes over the source video as it plays.
 *
 * The per-swing `objects` block in the details rail answers "what was on the
 * contact frame". This answers the question that one cannot: whether the boxes
 * track the racket and the ball THROUGH the swing, or land on a bag by the net
 * and stay there. That is only visible in motion, over the video the reviewer
 * is already watching.
 *
 * The data is `out/<session>/work/objects.jsonl.gz`, written by
 * `scripts/detect_objects.py`: a header line, then one line per SAMPLED frame.
 * Two properties of that file shape everything below —
 *
 *   1. A frame with no detections is omitted from the file entirely, so a gap
 *      between samples means "nothing was found", not "no sample was taken".
 *   2. The export applies no selection at all. It runs at `conf 0.10`, which
 *      carries duplicate boxes on one racket and spurious rackets on court
 *      furniture, and leaves the choosing to whatever reads it.
 *
 * Everything here is pure, like `source-playback.ts` beside it, so the lookup
 * and the letterbox arithmetic can be tested without a media element — which in
 * jsdom reports every dimension as zero and never advances `currentTime`.
 */

/** One box as the export writes it: `[x, y, w, h, conf]`, source-display px. */
export type BoxRow = [number, number, number, number, number];

/** The classes `detect_objects.py` keeps out of COCO. */
export const OBJECT_CLASSES = ['racket', 'ball', 'person'] as const;
export type ObjectClass = (typeof OBJECT_CLASSES)[number];

/** The export's first line: what was run, and over what. */
export interface ObjectsHeader {
  detector: string;
  weights: string;
  /** Sampling rate the export ran at — NOT the video's own frame rate. */
  fps: number;
  /** Frame size the boxes are measured against, in source-display pixels. */
  width: number;
  height: number;
  /** The detector's own floor. Every box in the file is at or above it. */
  conf: number;
}

/** One sampled frame. A class with no detections is absent from the line. */
export interface ObjectsFrame {
  /** Presentation time in the source video, ms. Read from the decoder. */
  ms: number;
  racket?: BoxRow[];
  ball?: BoxRow[];
  person?: BoxRow[];
}

export interface ObjectsDoc {
  header: ObjectsHeader;
  /** Ascending by `ms`, which `frameAt`'s binary search depends on. */
  frames: ObjectsFrame[];
}

const isRow = (v: unknown): v is BoxRow =>
  Array.isArray(v) && v.length >= 5 && v.slice(0, 5).every((n) => typeof n === 'number');

const rowsOf = (v: unknown): BoxRow[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const rows = v.filter(isRow).map((r): BoxRow => [r[0], r[1], r[2], r[3], r[4]]);
  return rows.length === 0 ? undefined : rows;
};

/**
 * The gzipped JSONL, once decompressed, as a document.
 *
 * Returns null when the first line is not a usable header: without `width` the
 * boxes cannot be scaled to anything, and drawing them at 1:1 over a video
 * displayed at a third of the source's size would put every box in the top-left
 * corner rather than reporting a problem.
 *
 * A malformed LINE costs itself and nothing else. The export is written
 * incrementally over minutes of GPU time, so a run killed part way through
 * leaves a truncated final line on disk — and that file is still worth watching
 * up to the point it stops.
 */
export function parseObjectsJsonl(text: string): ObjectsDoc | null {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;

  let head: unknown;
  try {
    head = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (typeof head !== 'object' || head === null) return null;
  const h = head as Record<string, unknown>;
  if (typeof h.width !== 'number' || typeof h.height !== 'number') return null;
  if (h.width <= 0 || h.height <= 0) return null;

  const header: ObjectsHeader = {
    detector: typeof h.detector === 'string' ? h.detector : 'unknown',
    weights: typeof h.weights === 'string' ? h.weights : 'unknown',
    fps: typeof h.fps === 'number' ? h.fps : 0,
    conf: typeof h.conf === 'number' ? h.conf : 0,
    width: h.width,
    height: h.height,
  };

  const frames: ObjectsFrame[] = [];
  for (const line of lines.slice(1)) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ms !== 'number') continue;
    const frame: ObjectsFrame = { ms: r.ms };
    for (const cls of OBJECT_CLASSES) {
      const rows = rowsOf(r[cls]);
      if (rows !== undefined) frame[cls] = rows;
    }
    frames.push(frame);
  }

  // Sorted rather than trusted: the exporter reads presentation times back from
  // the decoder on variable-frame-rate footage, and `frameAt` binary-searches
  // this list. One out-of-order sample would make the search skip a range.
  frames.sort((a, b) => a.ms - b.ms);
  return { header, frames };
}

/**
 * How long one sample stays on screen, in ms.
 *
 * A gap in the file means nothing was detected there, so "the nearest sample at
 * or before now" on its own keeps painting a racket that left the frame thirty
 * seconds ago. One and a half sampling intervals is wide enough to cover the
 * jitter of a variable-frame-rate source and narrow enough that a real gap goes
 * blank. Falls back to 100ms for a header claiming no rate at all, which is
 * about one frame of 10fps sampling.
 */
export const sampleLifeMs = (fps: number): number => (fps > 0 ? 1500 / fps : 100);

/**
 * The sample to draw at `ms`, or null.
 *
 * The nearest sample AT OR BEFORE the playhead, never after and never
 * interpolated between two. Interpolation is the tempting mistake here: at
 * 15 m/s the ball crosses most of a torso height between native frames, so a
 * straight line between two samples runs through positions it was never in —
 * and the whole point of the overlay is to say where the detector put it.
 *
 * Held for `maxAgeMs` and then dropped, so an unbroken run of samples looks
 * continuous while a genuine gap reads as one.
 */
export function frameAt(
  frames: ObjectsFrame[],
  ms: number,
  maxAgeMs: number,
): ObjectsFrame | null {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].ms <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  return ms - frames[found].ms > maxAgeMs ? null : frames[found];
}

/** A rectangle in the coordinates of the element it is measured against. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the overlay needs off a `<video>`, so callers can pass a plain object. */
export interface VideoBox {
  clientWidth: number;
  clientHeight: number;
  videoWidth: number;
  videoHeight: number;
}

/**
 * Where the picture actually is inside the video element.
 *
 * The element is letterboxed — `object-fit: contain` is the default, and the
 * stage sizes the element by height with a width cap — so its own box is
 * generally larger than the frame drawn in it. Scaling boxes by the ELEMENT's
 * width puts every one of them too far right by half the letterbox, which on
 * portrait footage in a wide stage is most of the screen.
 *
 * Null before `loadedmetadata`, and in jsdom, where every dimension is zero:
 * there is no picture to sit over yet.
 */
export function videoContentRect(el: VideoBox): Rect | null {
  const { clientWidth, clientHeight, videoWidth, videoHeight } = el;
  if (clientWidth <= 0 || clientHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: (clientWidth - width) / 2, top: (clientHeight - height) / 2, width, height };
}

/**
 * One box positioned over the element, in CSS pixels.
 *
 * Both axes are scaled independently rather than by one factor, because the
 * proxy and the source need not share an aspect ratio: the boxes are measured
 * against `header.width`/`header.height`, and the picture is whatever the
 * element is showing.
 */
export function boxRect(box: BoxRow, content: Rect, header: ObjectsHeader): Rect {
  const kx = content.width / header.width;
  const ky = content.height / header.height;
  return {
    left: content.left + box[0] * kx,
    top: content.top + box[1] * ky,
    width: box[2] * kx,
    height: box[3] * ky,
  };
}

/** One box to draw, with the class it came from. */
export interface DrawnBox {
  cls: ObjectClass;
  box: BoxRow;
}

/**
 * The boxes of one sample that pass the reviewer's filters.
 *
 * The floor is doing real work rather than tidying: the export keeps everything
 * the detector emitted at its own `conf 0.10`, which on this footage means two
 * or three boxes stacked on the same racket and further ones on the net post and
 * the bench. Without a floor the overlay shows the detector's raw opinion, which
 * is not what any downstream stage acts on.
 */
export function drawnBoxes(
  frame: ObjectsFrame | null,
  shown: ReadonlySet<ObjectClass>,
  confFloor: number,
): DrawnBox[] {
  if (frame === null) return [];
  const out: DrawnBox[] = [];
  for (const cls of OBJECT_CLASSES) {
    if (!shown.has(cls)) continue;
    for (const box of frame[cls] ?? []) {
      if (box[4] >= confFloor) out.push({ cls, box });
    }
  }
  return out;
}

/**
 * Confidence floors the control steps through.
 *
 * The first is the export's own floor — picking it shows literally everything
 * on disk, duplicates and furniture included, which is the right view when the
 * question is "did the detector see it at all". The default sits one step above
 * so the ordinary view is not that.
 */
export const CONF_STEPS = [0.1, 0.25, 0.5, 0.75] as const;
export const DEFAULT_CONF = 0.25;

/**
 * Which classes are drawn before the reviewer says otherwise.
 *
 * Person is off: it is a box around the thing a reviewer is already looking at,
 * and at full height it covers the racket and the ball the overlay exists to
 * show. It stays available because it is the only way to see the detector
 * splitting one player into two, or tracking the wrong body.
 */
export const DEFAULT_CLASSES: ObjectClass[] = ['racket', 'ball'];

/** Per-class colours, chosen to read against the stage's dark surface. */
export const CLASS_COLOUR: Record<ObjectClass, string> = {
  racket: '#ffd166',
  ball: '#4ddbff',
  person: 'rgba(250,249,233,0.55)',
};

/** `/api/objects/<session>` — the decompressed export, or 404 when there is none. */
export const objectsUrl = (session: string): string =>
  `/api/objects/${encodeURIComponent(session)}`;
