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

export type View = 'compare' | 'catalog' | 'detail';

export interface Frame {
  /** Index within the clip, 0-based over EVERY frame the ETL extracted.
   *  Rendered as `f01`…`f49`. */
  i: number;
  /** Milliseconds into the source video. The join key for `user-edit.json`;
   *  `i` is only a render index and shifts when sampling changes. */
  sourceMs: number;
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
  /** True once a human has confirmed or corrected any of the auto tags. */
  triaged: boolean;
  grade: Grade | null;
  note: string;
  frames: Frame[];
}

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
 * NOT a per-clip truth — a `Clip` carries every frame the ETL extracted (42-49
 * on real footage). Narrowing happens in `buildCompare`, which is the only view
 * that needs a fixed width, because it lays every clip on one shared timeline.
 * The seed builds 9-frame clips so it renders as one full window.
 */
export const FRAMES_PER_CLIP = 9;
