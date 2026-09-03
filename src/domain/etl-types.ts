/**
 * TypeScript mirror of the shapes `tennisproc` writes. Field names are
 * snake_case because these describe JSON on disk, not app values — the
 * boundary where they become camelCase is `etl.ts`.
 *
 * Enums are duplicated from `tennisproc/schema.py`, which owns them. Keep in
 * step with STAGES / STROKES / VERDICTS / PLAYER_SLOTS / QUALITY there.
 */

/**
 * The vocabularies as runtime arrays, not just types.
 *
 * `user-edit.json` can be hand-edited or written by another tool, so a value
 * arriving on the read path is only *claimed* to be a member — the types above
 * describe what `tennisproc` writes, not what the app might be handed. Write-back
 * has to be able to check membership before echoing a value back
 * (`sanitiseLabels` in `etl-write.ts`), and that needs the list at runtime.
 *
 * Each type is derived from its array so the two cannot drift apart here; they
 * still have to be kept in step with STAGES / STROKES / VERDICTS / PLAYER_SLOTS
 * / QUALITY in `tennisproc/schema.py`, which owns them.
 */
export const ETL_STAGES = ['setup', 'contact', 'finish', 'other'] as const;
export type EtlStage = (typeof ETL_STAGES)[number];

export const ETL_STROKES = [
  'forehand',
  'backhand',
  'volley',
  'serve',
  'overhead',
  'other',
] as const;
export type EtlStroke = (typeof ETL_STROKES)[number];

export const ETL_VERDICTS = ['valid', 'false_positive', 'duplicate', 'unclear'] as const;
export type EtlVerdict = (typeof ETL_VERDICTS)[number];

export const ETL_PLAYER_SLOTS = ['left', 'right', 'near', 'far'] as const;
export type EtlPlayerSlot = (typeof ETL_PLAYER_SLOTS)[number];

export const ETL_QUALITY = [1, 2, 3, 4, 5] as const;
export type EtlQuality = (typeof ETL_QUALITY)[number];

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
  quality: EtlQuality | null;
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
  /**
   * `doc_hash` of the ETL output this review was made against, so `overlay()` can
   * warn when the clip has been re-rendered since (`schema.py:419`).
   *
   * `null`, not absent, when there is nothing to record: `optional=True` in
   * `_Check.field` means "null is allowed", and `field()` reports `missing`
   * *before* it consults `optional` — so `against: null` validates and an absent
   * `against` does not. Optional here in the TS sense only because a document
   * read off disk may genuinely lack the key.
   */
  against?: string | null;
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
  /** The session these `swings` came from — one source video. */
  session: string;
  swings: SwingEntry[];
  /**
   * Every session in the tree, `session` included, so the picker can list them
   * without a second round trip. One name per source video: nine clips of one
   * afternoon are nine sessions here, because a session is whatever one
   * `ffprobe` call can describe.
   */
  sessions: string[];
  /**
   * What the ETL probed about the source video, or null for a tree that has
   * no readable swing to take it from.
   *
   * Read off a swing rather than the session document, because `source` is
   * copied into every swing on purpose and a session killed mid-render has no
   * session document at all — IMG_0306 and IMG_0307 were both in that state.
   */
  source: EtlSource | null;
  /**
   * The session's full-length playable video, or null when there is none.
   *
   * Null on trees written before proxies existed, and on any session whose
   * source video was gone at transcode time. The review app plays this and
   * seeks within it; with no proxy it falls back to the per-swing clips.
   */
  proxy: EtlProxy | null;
  /**
   * The detector's own tuning for this session, as `Settings.as_metadata()`
   * wrote it, or null on a tree with no session document.
   *
   * Open-shaped on purpose: `tennisproc/config.py` owns these keys and adds to
   * them freely (`scan_k`, `min_wrist_speed`, `pose_model`, …), and a mirror
   * that had to be updated in lockstep would go stale silently.
   */
  settings: Record<string, unknown> | null;
  /** Candidate/verified/rejected counts and the reject histogram. */
  detection: Record<string, unknown> | null;
}

/**
 * The `proxy` block of a SessionDoc: one transcode of the WHOLE source.
 *
 * Uncut by construction, so `trim.source_start_ms` addresses it directly with
 * no offset arithmetic — the reason a swing whose detected window is wrong can
 * still be scrubbed past, which a pre-cut clip could never allow.
 */
export interface EtlProxy {
  /** Basename, resolved against the session directory. */
  file: string;
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  bytes: number;
}

/** The `source` block of a SwingDoc, as `probe.probe()` writes it. */
export interface EtlSource {
  name: string;
  path: string;
  sha256_16: string;
  bytes: number;
  duration_ms: number;
  fps: number;
  vfr: boolean;
  width: number;
  height: number;
  rotation: number;
  has_audio: boolean;
  audio_sr?: number;
  /** Source file mtime, ISO 8601. Absent in trees rendered before it existed. */
  modified?: string;
}
