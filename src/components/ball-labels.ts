import { parseObjectsJsonl, type BoxRow, type ObjectsFrame, type ObjectsHeader } from './object-overlay.ts';

/**
 * Ground-truth ball positions, made by a human confirming a detector's guesses.
 *
 * The need is measured: a COCO-pretrained YOLO puts a ball somewhere in 73% of
 * this session's frames, but only 8.5% of those detections MOVE — the rest are
 * dead balls lying on the court. TrackNet's pretrained weights and both of
 * ultralytics' stock trackers (ByteTrack, BoT-SORT) failed on this footage
 * outright. So nothing here can be evaluated without labels a person made, and
 * the fastest way to make them is to confirm or correct a guess rather than to
 * click into an empty frame.
 *
 * Two files, and they are not the same file:
 *
 *   - `work/ball-candidates.jsonl.gz` — what to confirm. NATIVE 60fps, windowed
 *     to contact ±500ms for a sample of swings, so ~60 frames per window rather
 *     than the whole session. Read-only, written by the detector.
 *   - `ball-labels.json` — what the human decided. One per SESSION, keyed by
 *     source timestamp.
 *
 * The key is a timestamp and never a swing id. Re-running detection renumbers
 * `swings/swing_NNN` wholesale, and anything keyed to those numbers is orphaned
 * the moment it does — that has already destroyed a set of human verdicts once
 * in this project. A source timestamp survives re-detection, because it names a
 * moment in the video rather than a row in a directory listing.
 *
 * Everything here is pure, like `object-overlay.ts` beside it, so the lookup,
 * the candidate choice and the click arithmetic can be tested without a media
 * element — which in jsdom reports every dimension as zero and never advances
 * `currentTime`.
 */

/** One labelling window: the span of frames the candidate file covers. */
export interface LabelWindow {
  startMs: number;
  endMs: number;
  /** The detector's contact moment inside it, when the header names one. */
  contactMs?: number;
}

/**
 * The candidate file's header.
 *
 * `ObjectsHeader`'s fields mean the same things here — `width`/`height` are the
 * source-display frame the boxes are measured against, and `boxRect` scales
 * against them unchanged. `fps: 0` is this file's way of saying "native rate,
 * and windowed", which is why the windows have to be carried explicitly: they
 * cannot be recovered from a sampling interval that does not exist.
 */
export interface BallCandidatesHeader extends ObjectsHeader {
  windows: LabelWindow[];
}

export interface BallCandidatesDoc {
  header: BallCandidatesHeader;
  /** Ascending by `ms`. One entry per native frame inside a window; a frame
   *  with no detection carries no `ball` key rather than an empty list. */
  frames: ObjectsFrame[];
}

/**
 * The candidate export, parsed.
 *
 * The frame lines are read by `parseObjectsJsonl`, unchanged: the two files
 * share that format exactly, including the two properties that matter — a
 * detection-free frame omits its class key, and a run killed part way through
 * leaves a truncated final line that must cost itself and nothing else. This
 * export is written incrementally over minutes of GPU time, so that last case
 * is the ordinary state of the file while it is still being produced.
 *
 * What this adds is `windows`, which `ObjectsHeader` has no room for and the
 * overlay has no use for.
 */
export function parseBallCandidates(text: string): BallCandidatesDoc | null {
  const base = parseObjectsJsonl(text);
  if (base === null) return null;

  const firstLine = text.split('\n').find((l) => l.trim() !== '');
  let head: unknown = null;
  try {
    head = firstLine === undefined ? null : JSON.parse(firstLine);
  } catch {
    // Unreachable in practice: `parseObjectsJsonl` already returned null for a
    // header it could not parse. Guarded anyway so this never throws past its
    // own caller, which is a fetch handler that treats every failure as "no
    // candidates for this session".
    head = null;
  }
  const h = (typeof head === 'object' && head !== null ? head : {}) as Record<string, unknown>;

  const windows = readWindows(h.windows, h.contacts);
  return {
    header: {
      ...base.header,
      // A header naming no windows still says which frames are worth labelling
      // — through the frames it carries — so it collapses to one window over
      // all of them rather than to a state every consumer has to branch on.
      windows: windows.length > 0 ? windows : spanOf(base.frames),
    },
    frames: base.frames,
  };
}

/** `[[start, end], ...]` paired with `contacts` by position, as the file writes them. */
function readWindows(raw: unknown, contacts: unknown): LabelWindow[] {
  if (!Array.isArray(raw)) return [];
  const times: unknown[] = Array.isArray(contacts) ? (contacts as unknown[]) : [];
  const out: LabelWindow[] = [];
  for (const [i, pair] of (raw as unknown[]).entries()) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') {
      continue;
    }
    if (pair[1] < pair[0]) continue;
    const contactMs = times[i];
    out.push({
      startMs: pair[0],
      endMs: pair[1],
      ...(typeof contactMs === 'number' ? { contactMs } : {}),
    });
  }
  // Sorted for the same reason `parseObjectsJsonl` sorts frames: the UI walks
  // this list forwards, and one out-of-order window would make "next window"
  // jump backwards through the session.
  return out.sort((a, b) => a.startMs - b.startMs);
}

const spanOf = (frames: ObjectsFrame[]): LabelWindow[] =>
  frames.length === 0
    ? []
    : [{ startMs: frames[0].ms, endMs: frames[frames.length - 1].ms }];

/** `/api/ball-candidates/<session>` — the decompressed export, or 404. */
export const ballCandidatesUrl = (session: string): string =>
  `/api/ball-candidates/${encodeURIComponent(session)}`;

/** `/api/ball-labels/<session>` — GET reads the file, PUT replaces it. */
export const ballLabelsUrl = (session: string): string =>
  `/api/ball-labels/${encodeURIComponent(session)}`;

/**
 * The centre of a ball, in source-display pixels, or `null` for "a human looked
 * at this frame and there is no ball in it".
 *
 * That null is a LABEL, not a gap. An absent key means nobody has looked yet,
 * and the two are the difference between "the tracker missed a ball that was
 * there" and "the tracker invented one that was not" — which is most of what
 * these labels exist to measure.
 */
export type BallLabel = [number, number] | null;

/** Source timestamp in ms, as a decimal string, to the centre or to null. */
export type BallLabels = Record<string, BallLabel>;

export const BALL_LABELS_SCHEMA = 'tennis.ball-labels/1';

/**
 * The space every coordinate in this file is measured in.
 *
 * Written into the document rather than assumed, because the project also
 * carries crop-space and model-input-space coordinates for the same frames, and
 * a bare pair of numbers with no space named is not a label anyone can use a
 * year from now.
 */
export const BALL_LABELS_SPACE = 'source_display';

export interface BallLabelsDoc {
  schema: typeof BALL_LABELS_SCHEMA;
  session: string;
  space: typeof BALL_LABELS_SPACE;
  labels: BallLabels;
}

/**
 * The key for a source timestamp.
 *
 * Rounded to a whole millisecond: the candidate file writes integer `ms`, and a
 * key that could arrive as `79733` or `79733.0000001` depending on how it was
 * computed is not a key at all. Callers pass a frame's own `ms` from the
 * candidate file, never a `video.currentTime` — the element reports whatever
 * position the seek actually landed on, which is not the frame's timestamp.
 */
export const labelKey = (ms: number): string => String(Math.round(ms));

export const ballLabelsDoc = (session: string, labels: BallLabels): BallLabelsDoc => ({
  schema: BALL_LABELS_SCHEMA,
  session,
  space: BALL_LABELS_SPACE,
  labels,
});

/** Whether a key is a whole-millisecond timestamp, and nothing else. */
const MS_KEY = /^\d+$/;

/**
 * A label document read back off disk or the wire, or null if it is not one.
 *
 * Null for a document whose `schema` or `space` is not this one: coordinates in
 * an unnamed space are unusable, and reading a future schema with this version's
 * rules would silently reinterpret somebody's ground truth.
 *
 * An individual ENTRY that cannot be read is dropped and the rest kept, the same
 * rule `sanitiseTags` follows for the same reason — the file is human work, and
 * the aim is to lose as little of it as possible to one bad line. A dropped
 * entry reads as "nobody has looked at this frame", which is recoverable by
 * looking; a coerced one would be a ground-truth position no human ever put
 * there, which is not.
 */
export function parseBallLabels(value: unknown): BallLabelsDoc | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== BALL_LABELS_SCHEMA) return null;
  if (doc.space !== BALL_LABELS_SPACE) return null;
  if (typeof doc.session !== 'string') return null;
  if (typeof doc.labels !== 'object' || doc.labels === null || Array.isArray(doc.labels)) {
    return null;
  }

  const labels: BallLabels = {};
  for (const [key, raw] of Object.entries(doc.labels as Record<string, unknown>)) {
    if (!MS_KEY.test(key)) continue;
    if (raw === null) {
      labels[key] = null;
      continue;
    }
    if (
      Array.isArray(raw) &&
      raw.length === 2 &&
      typeof raw[0] === 'number' &&
      typeof raw[1] === 'number' &&
      Number.isFinite(raw[0]) &&
      Number.isFinite(raw[1])
    ) {
      labels[key] = [raw[0], raw[1]];
    }
  }
  return { schema: BALL_LABELS_SCHEMA, session: doc.session, space: BALL_LABELS_SPACE, labels };
}

/** The centre of a `[x, y, w, h, conf]` box, which is what a label records. */
export const centreOf = (box: BoxRow): [number, number] => [
  box[0] + box[2] / 2,
  box[1] + box[3] / 2,
];

/**
 * Which candidate to offer first, as an index into `boxes`.
 *
 * Nearest the previously accepted label, because that is the question a human
 * is actually answering: this footage carries dead balls lying on the court that
 * the detector finds in almost every frame, often more confidently than the ball
 * in flight, so "the most confident box" is systematically the wrong one — 91.5%
 * of detections in this session do not move at all. The ball a person is
 * following, by contrast, is a few tens of pixels from where they last put it.
 *
 * No distance cap. A cap would need a speed to justify it and the honest number
 * is enormous: at 30 m/s the ball crosses a good fraction of the frame between
 * native frames, and a cap tight enough to exclude a court ball would also
 * exclude the fastest real ones. Cycling with a key is the answer to a wrong
 * offer instead — it costs one keystroke and it cannot be wrong about physics.
 *
 * Falls back to the most confident box when there is no previous label, which is
 * the first frame of a window and nothing else.
 */
export function pickCandidate(boxes: BoxRow[], previous: readonly [number, number] | null): number {
  if (boxes.length === 0) return -1;
  if (previous === null) {
    return boxes.reduce((best, box, i) => (box[4] > boxes[best][4] ? i : best), 0);
  }
  let best = 0;
  let bestGap = Infinity;
  for (const [i, box] of boxes.entries()) {
    const [cx, cy] = centreOf(box);
    const gap = (cx - previous[0]) ** 2 + (cy - previous[1]) ** 2;
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The most recent accepted position at or before `ms`, or null.
 *
 * "Accepted" excludes a `null` label: a frame a human marked empty says nothing
 * about where the ball is, so anchoring the next frame's candidate choice on it
 * would mean anchoring on nothing. Walking back past it to the last real
 * position is what keeps `pickCandidate` useful across a frame or two where the
 * detector lost the ball.
 */
export function lastPosition(
  frames: ObjectsFrame[],
  index: number,
  labels: BallLabels,
): [number, number] | null {
  for (let i = Math.min(index, frames.length) - 1; i >= 0; i--) {
    const at = labels[labelKey(frames[i].ms)];
    if (at !== undefined && at !== null) return at;
  }
  return null;
}

/** The window `ms` falls inside, as an index, or -1. Ends are inclusive. */
export function windowAt(windows: LabelWindow[], ms: number): number {
  return windows.findIndex((w) => ms >= w.startMs && ms <= w.endMs);
}

/**
 * The frame nearest `ms`, as an index into `frames`, or -1 for an empty list.
 *
 * Nearest rather than at-or-before, unlike `frameAt` in the overlay: this
 * answers "where should labelling start from" for a playhead that may be
 * anywhere in the session, including in one of the long gaps between windows.
 * At-or-before would put a reviewer who paused just short of a window at the end
 * of the PREVIOUS one, half a minute of video away from what they were watching.
 */
export function nearestFrame(frames: ObjectsFrame[], ms: number): number {
  if (frames.length === 0) return -1;
  let best = 0;
  let bestGap = Math.abs(frames[0].ms - ms);
  for (let i = 1; i < frames.length; i++) {
    const gap = Math.abs(frames[i].ms - ms);
    // Strictly less, so ties go to the earlier frame — the same rule
    // `nearestSwing` uses, and it keeps the choice stable as `ms` grows.
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/** The first frame of `window`, as an index, or -1 when it holds none. */
export const firstFrameOf = (frames: ObjectsFrame[], window: LabelWindow): number =>
  frames.findIndex((f) => f.ms >= window.startMs && f.ms <= window.endMs);

/**
 * How much of one window is done.
 *
 * Counts a `null` as labelled, because it is one: "no ball here" is a call a
 * human made about that frame, and a progress readout that ignored it would
 * tell a reviewer they still had work on the frames they had just finished.
 */
export function windowProgress(
  frames: ObjectsFrame[],
  window: LabelWindow,
  labels: BallLabels,
): { labelled: number; total: number } {
  let labelled = 0;
  let total = 0;
  for (const frame of frames) {
    if (frame.ms < window.startMs || frame.ms > window.endMs) continue;
    total += 1;
    if (labels[labelKey(frame.ms)] !== undefined) labelled += 1;
  }
  return { labelled, total };
}

/** A rectangle in the coordinates of the element it is measured against. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A click on the video element, in source-display pixels, or null.
 *
 * The inverse of `boxRect`: `content` is where the picture actually sits inside
 * the letterboxed element, so the offset has to come off before the scale goes
 * on. Both axes are scaled independently, for `boxRect`'s reason — the proxy and
 * the source need not share an aspect ratio.
 *
 * Null for a click OUTSIDE the picture, on the letterbox bars. Clamping instead
 * would record a ball pinned to the edge of the frame, which is a position no
 * human meant and which the reviewer has no way to see is wrong.
 */
export function sourcePoint(
  x: number,
  y: number,
  content: Rect,
  header: Pick<ObjectsHeader, 'width' | 'height'>,
): [number, number] | null {
  if (content.width <= 0 || content.height <= 0) return null;
  const fx = (x - content.left) / content.width;
  const fy = (y - content.top) / content.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return [fx * header.width, fy * header.height];
}

/** Where a labelled point sits over the element, in CSS pixels. */
export function pointRect(
  point: readonly [number, number],
  content: Rect,
  header: Pick<ObjectsHeader, 'width' | 'height'>,
): { left: number; top: number } {
  return {
    left: content.left + (point[0] / header.width) * content.width,
    top: content.top + (point[1] / header.height) * content.height,
  };
}

/**
 * How long to wait after the last label before writing the file, in ms.
 *
 * The whole point is that a reload cannot cost twenty minutes of labelling, so
 * this is a bound on work at risk rather than a performance knob: at a keypress
 * roughly every second, half of one is the most a crash can take. It is shorter
 * than the store's 600ms write-back for `user-edit.json` because a labelling
 * pass produces an edit far more often than a triage pass does, and each one is
 * a fact about a frame nobody will ever look at again.
 */
export const LABEL_WRITE_MS = 400;

/** The colour of a candidate box, and of the one currently offered. */
export const CANDIDATE_COLOUR = 'rgba(250,249,233,0.45)';
export const OFFERED_COLOUR = '#ffd166';
/** The accepted label's crosshair. Distinct from every candidate colour. */
export const LABEL_COLOUR = '#4dff9f';
