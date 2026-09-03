/** The three swing phases the classifier tags. A frame between them is `null`. */
export type Phase = 'setup' | 'contact' | 'finish';

/** Coach's verdict on a clip. Absent (`null`) means unrated. */
export type Grade = 'good' | 'ok' | 'work';

/**
 * Mirrors `STROKES` in `tennisproc/schema.py`, which owns the vocabulary.
 * `Slice` is deliberately absent: the ETL cannot emit it (spin is not
 * recoverable at 30 fps), so nothing could ever produce the value.
 */
export const STROKES = [
  'Forehand',
  'Backhand',
  'Serve',
  'Volley',
  'Overhead',
  'Other',
] as const;
export type Stroke = (typeof STROKES)[number];

/** Shown where a stroke would go on a clip the ETL left unlabelled. */
export const UNTAGGED_STROKE = 'untagged';

/**
 * `keyframes` is the primary view: the source video with a tick per swing.
 * The other three predate it and read pre-cut clips.
 */
export type View = 'keyframes' | 'compare' | 'catalog' | 'detail';

export interface Frame {
  /** Index within the clip, 0-based over EVERY frame the ETL extracted.
   *  Rendered as `f01`, `f02`, … however many the tree carries. */
  i: number;
  /** Milliseconds into the source video. The join key for `user-edit.json`;
   *  `i` is only a render index and shifts when sampling changes. */
  sourceMs: number;
  /**
   * Milliseconds from this frame to the detector's contact moment, signed:
   * negative before contact, positive after, and exactly 0 ON contact.
   *
   * The ETL's own answer to "where is contact", carried through so the compare
   * grid can align on it. Absent on seeded clips, which have no detector — the
   * grid falls back to the frame list's midpoint there.
   */
  offsetContactMs?: number;
  phase: Phase | null;
  /**
   * Classifier confidence, 0–1. Below CONFIDENCE_FLOOR the frame is flagged.
   * Absent on ETL clips: there is no classifier, and `pose_score` measures
   * landmark quality, which is a different quantity.
   */
  conf?: number;
  /** Served by the dev middleware. Absent for seeded clips. */
  imageUrl?: string;
}

export interface Clip {
  id: string;
  player: string;
  /** Null until a human labels it — the ETL ships every stroke unlabelled. */
  stroke: Stroke | null;
  conf?: number;
  rejected: boolean;
  duration: string;
  /**
   * Where this clip was cut from in the source video, in milliseconds.
   *
   * Absent on seeded clips, which came from no video. Shown on the row because
   * it is the fact that distinguishes one from the next: every clip runs the
   * same 3.5s by construction, so the duration alone reads as a column of
   * identical text, while "0:58-1:01" says which moment of the afternoon this
   * is and where to find it in the original file.
   */
  sourceStartMs?: number;
  sourceEndMs?: number;
  /**
   * The detector's contact moment, in source-video time.
   *
   * The instant the window was built around, so it is the one worth marking
   * when the window itself is in doubt: a swing whose contact sits hard against
   * an edge of its window is one the detector timed badly, and that is visible
   * at a glance on the scrubber rather than only by watching it.
   *
   * Absent on seeded clips, which have no detector behind them.
   */
  contactMs?: number;
  /** True once a human has confirmed or corrected any of the auto tags. */
  triaged: boolean;
  grade: Grade | null;
  note: string;
  frames: Frame[];
  /**
   * The swing's rendered clip, where one exists.
   *
   * Absent on seeded clips, which have no media behind them. The stills answer
   * "what shape was the body at this instant"; only the video answers "was this
   * a shot at all", which is the call a reviewer has to make before any of the
   * others are worth making.
   */
  videoUrl?: string;
  /**
   * What the verifier measured, for the reviewer to judge against.
   *
   * Absent on seeded clips and on any swing whose `measurements` block the ETL
   * left null. Numbers, not a verdict: `isSuspect` turns them into one.
   */
  measurements?: ClipMeasurements;
}

export interface ClipMeasurements {
  /** Peak wrist speed, in torso heights per second. Saturates at 40. */
  wristSpeed: number;
  /** Hitting wrist's distance from the body midline at contact, in torso heights. */
  armOffset: number;
}

/**
 * Whether a swing reads as "the detector fired, but nobody hit anything".
 *
 * Both halves are needed, and neither alone is enough. Measured over the 329
 * swings of the first four sessions: speed has no gap to cut at — thresholds
 * from 2 to 12 shave off 2% to 41% with nothing to distinguish a soft volley
 * from a non-shot. Arm extension separates far better (157 of 206 swings above
 * speed 10 have the arm out, against almost none of the slow ones), but a
 * genuine drop-shot is slow with the arm out too.
 *
 * Together they flag 18% of the tree: slow AND the wrist still at the midline,
 * which is a body standing still. This is a sorting aid, not a filter the
 * pipeline applies — `IMG_0305/swing_019` at speed 2.27 and offset 0.01 is
 * still a swing until a human looks at the clip and says otherwise.
 */
export const SUSPECT_SPEED = 5;
export const SUSPECT_ARM = 0.4;

/**
 * A clip id with its session prefix dropped: `IMG_0305/swing_042` -> `swing_042`.
 *
 * The prefix is the same on every row once the header names the source, so it
 * was 11 characters of noise repeated down the whole grid. The full id stays in
 * each element's `title`, because it is what identifies the swing on disk and
 * in `user-edit.json`.
 */
export const shortId = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/**
 * What a downloaded clip is called on disk.
 *
 * `clip.id` is `IMG_0312/swing_005`: a browser reads the slash as a path
 * separator and saves `swing_005`, so nine sessions of downloads collide on
 * the same nine filenames. The session belongs in the name. The extension is
 * taken from the URL rather than assumed — the ETL emits .mp4 or .webm
 * depending on what the source was — and is omitted if the URL carries none,
 * which is better than appending a wrong one.
 */
export const clipFileName = (id: string, videoUrl: string): string => {
  const dot = videoUrl.lastIndexOf('.');
  const slash = videoUrl.lastIndexOf('/');
  const ext = dot > slash ? videoUrl.slice(dot) : '';
  return `${id.replace(/\//g, '_')}${ext}`;
};

/** `m:ss` from milliseconds, floored — the clock convention used throughout. */
const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Where a clip sits in its source video, as `0:58–1:01`.
 *
 * Falls back to the duration for a clip that carries no source timing — the
 * seed, which came from no video at all.
 */
/** Where this clip starts in the source video, as `0:40`. */
export const sourceStart = (clip: Clip): string =>
  clip.sourceStartMs === undefined ? clip.duration : clock(clip.sourceStartMs);

/** Where it ends, as `0:44`. */
export const sourceEnd = (clip: Clip): string =>
  clip.sourceEndMs === undefined ? clip.duration : clock(clip.sourceEndMs);

/**
 * How long the clip runs, as `3.5s`.
 *
 * To one decimal, unlike `clip.duration`: every clip is the same 3.5s window,
 * and a whole-second clock renders that as "0:03", which is both wrong and
 * indistinguishable from a 3.0s clip if the window ever changes.
 */
export const clipLength = (clip: Clip): string => {
  if (clip.sourceStartMs === undefined || clip.sourceEndMs === undefined) {
    return clip.duration;
  }
  const seconds = (clip.sourceEndMs - clip.sourceStartMs) / 1000;
  return `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
};

export const sourceRange = (clip: Clip): string => {
  if (clip.sourceStartMs === undefined || clip.sourceEndMs === undefined) {
    return clip.duration;
  }
  // Length in parentheses, to one decimal. `clock()` floors to whole seconds,
  // so a 3.5s clip reads "0:05–0:08" and looks like three; the exact figure
  // resolves that without making the range itself harder to scan.
  const seconds = (clip.sourceEndMs - clip.sourceStartMs) / 1000;
  const length = `${seconds.toFixed(1).replace(/\.0$/, '')}s`;
  return `${clock(clip.sourceStartMs)}–${clock(clip.sourceEndMs)} (${length})`;
};

export const isSuspect = (clip: Clip): boolean =>
  clip.measurements !== undefined &&
  clip.measurements.wristSpeed < SUSPECT_SPEED &&
  Math.abs(clip.measurements.armOffset) < SUSPECT_ARM;

export interface Comment {
  id: number;
  /** Clip id the comment is pinned to. */
  clip: string;
  /** Frame index within that clip. */
  frame: number;
  author: string;
  /** Relative age label as shown in the UI ("2d", "now") — not a timestamp. */
  at: string;
  text: string;
}

export interface Selection {
  clip: string;
  frame: number;
}

export const ALL_PLAYERS = 'All players';
export const ALL_STROKES = 'All strokes';
export const ALL_RATINGS = 'All ratings';

/** Sentinel option in the player dropdowns that opens the "new player" bar. */
export const ADD_PLAYER = '+ Add player…';

/** Frames below this confidence are flagged for review and count as pending. */
export const CONFIDENCE_FLOOR = 0.7;

/**
 * Width of the compare grid's window, in frames: how many stills of one clip
 * the aligned view shows at once, centred on that clip's anchor.
 *
 * NOT a per-clip truth — a `Clip` carries every frame the ETL extracted, which
 * is 7 on the current trees and was 42-49 on the native-fps ones. Narrowing
 * happens in `buildCompare`, the only view that needs a fixed width, because it
 * lays every clip on one shared timeline. A clip with fewer frames than this
 * simply fills fewer columns.
 * The seed builds 9-frame clips so it renders as one full window.
 */
export const FRAMES_PER_CLIP = 9;
