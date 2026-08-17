/**
 * TypeScript mirror of the shapes `tennisproc` writes. Field names are
 * snake_case because these describe JSON on disk, not app values — the
 * boundary where they become camelCase is `etl.ts`.
 *
 * Enums are duplicated from `tennisproc/schema.py`, which owns them. Keep in
 * step with STAGES / STROKES / VERDICTS / PLAYER_SLOTS there.
 */

export type EtlStage = 'setup' | 'contact' | 'finish' | 'other';

export type EtlStroke =
  | 'forehand'
  | 'backhand'
  | 'volley'
  | 'serve'
  | 'overhead'
  | 'other';

export type EtlVerdict = 'valid' | 'false_positive' | 'duplicate' | 'unclear';

export type EtlPlayerSlot = 'left' | 'right' | 'near' | 'far';

export interface EtlFrame {
  file: string;
  source_ms: number;
  clip_ms: number;
  offset_contact_ms: number;
  /** Null on frames outside the pose window — normal, not an error. */
  pose_score: number | null;
  stage: EtlStage | null;
}

export interface EtlLabels {
  /** Optional in schema.py:165 — can be null. */
  player_slot: EtlPlayerSlot | null;
  player_name: string | null;
  stroke: EtlStroke | null;
  quality: 1 | 2 | 3 | 4 | 5 | null;
  verdict: EtlVerdict | null;
  tags: string[];
  notes: string | null;
}

export interface EtlTrim {
  file: string;
  source_start_ms: number;
  source_end_ms: number;
  encoded_start_ms: number;
  width: number;
  height: number;
}

export interface EtlDetection {
  method: string;
  contact_ms: number;
  onset_peak: number | null;
  verified: boolean;
  reject_reason: string | null;
}

export interface EtlEdit {
  by: string;
  at: string;
  against?: string;
  reviewed: boolean;
}

export interface EtlSwingDoc {
  schema: 'tennis.swing/1';
  id: string;
  source: Record<string, unknown>;
  trim: EtlTrim;
  crop: Record<string, unknown>;
  detection: EtlDetection;
  labels: EtlLabels;
  frames: EtlFrame[];
  measurements: Record<string, unknown> | null;
  edit: EtlEdit | null;
}

export interface EtlSwingRef {
  id: string;
  dir: string;
  contact_ms: number;
  duration_ms: number;
  /** Optional in schema.py:356-357 — can be null. */
  player_slot: EtlPlayerSlot | null;
  frame_count: number;
  verified: boolean;
  reviewed: boolean;
}

export interface EtlSessionDoc {
  schema: 'tennis.session/1';
  source: { name: string; [k: string]: unknown };
  settings: Record<string, unknown>;
  detection: Record<string, unknown>;
  players: Record<string, unknown>;
  swings: EtlSwingRef[];
}

/** One swing as `/api/session` returns it: the doc, where it lives, and its hash. */
export interface SwingEntry {
  dir: string;
  /** `doc_hash` of the ETL-owned content, for `edit.against`. */
  hash: string;
  /** The ETL's `metadata.json` with any `user-edit.json` overlaid. */
  doc: EtlSwingDoc;
  /**
   * The previous `user-edit.json` exactly as it sits on disk, unmerged, or null
   * when this swing has never been reviewed.
   *
   * Needed because `doc` is the MERGED view, and `overlay()` drops frames whose
   * `source_ms` is absent from `metadata.json` *from that view* while
   * deliberately leaving them on disk — so re-running the ETL at the original
   * `--fps` recovers a human's tags. Write-back has to carry those entries
   * through, and the merged doc no longer knows they exist.
   */
  edit: EtlSwingDoc | null;
}

/** The whole `/api/session` response. */
export interface SessionPayload {
  session: string;
  swings: SwingEntry[];
}
