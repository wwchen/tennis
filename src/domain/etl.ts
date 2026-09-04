import type {
  EtlFrame,
  EtlStage,
  EtlStroke,
  EtlSwingDoc,
  SessionPayload,
  SwingEntry,
} from './etl-types';
import type {
  BallBox,
  Clip,
  ClipDetection,
  ClipMeasurements,
  ClipObjects,
  Frame,
  Grade,
  ObjectBox,
  Phase,
  Stroke,
} from './types';
import { frameWindow } from './window';

/**
 * The compare grid's window over a swing's stills, in `source_ms` space:
 * the run of frames the aligned view can show at once, centred on contact.
 *
 * NOT used by `adaptSwing` — a `Clip` carries every frame, and `buildCompare`
 * applies `frameWindow` in index space. This is the same window expressed
 * against raw ETL frames, for callers that hold a `contact_ms` rather than a
 * frame index. Both go through `frameWindow`, so there is one definition.
 *
 * Contact is never dropped: the window always contains its anchor, and the
 * frames come back in `source_ms` order without repeats because the indices
 * ascend over a list the schema requires to be strictly increasing. They are
 * strided rather than adjacent — see `frameWindow`.
 */
export function sampleFrames(frames: EtlFrame[], contactMs: number): EtlFrame[] {
  if (frames.length === 0) return [];

  let contact = 0;
  for (let i = 1; i < frames.length; i++) {
    if (
      Math.abs(frames[i].source_ms - contactMs) <
      Math.abs(frames[contact].source_ms - contactMs)
    ) {
      contact = i;
    }
  }

  return frameWindow(frames.length, contact).map((i) => frames[i]);
}

/**
 * Whether this clip reads as removed.
 *
 * Shared with `etl-write.ts`: write-back has to tell a verdict the reviewer set
 * from the one it read, and it can only do that against the same rule the read
 * adapter applied.
 *
 * `detection.verified` is ETL-owned — the app cannot clear it — so a plain OR
 * with it never converges: an unverified swing always read as rejected, so
 * "restore" wrote `valid`, the next load re-rejected it, and a subsequent
 * "remove" wrote `valid` again, recording the reviewer's rejection as an accept
 * call. A human's verdict therefore has to be able to disagree with `verified`:
 *
 *   verdict            verified   rejected   why
 *   -----------------  ---------  ---------  --------------------------------
 *   false_positive     any        yes        an explicit rejecting call
 *   duplicate          any        yes        an explicit rejecting call
 *   valid              true       no         accepted, and the ETL agrees
 *   valid              FALSE      no         a human overrode the detector;
 *                                            this is the row that converges
 *   unclear            true       no         not a rejection, so nothing to
 *                                            override `verified` with
 *   unclear            false      yes        `unclear` is not an accept call
 *   null               true       no         untouched, and the ETL is happy
 *   null               false      yes        the ETL's own rejection stands,
 *                                            with no human call against it
 *
 * So: a rejecting verdict always rejects, `valid` always accepts, and anything
 * that is not a call either way defers to `detection.verified`.
 */
export const isRejected = (doc: EtlSwingDoc): boolean => {
  const { verdict } = doc.labels;
  if (verdict === 'false_positive' || verdict === 'duplicate') return true;
  if (verdict === 'valid') return false;
  return !doc.detection.verified;
};

/**
 * The name `adaptSwing` puts on a clip.
 *
 * A slot is a court zone, not a person, and `'unassigned'` is neither — both
 * only stand in for a name the pipeline cannot know. `etl-write.ts` compares
 * against this to tell a name a human typed from a placeholder it supplied.
 */
export const playerOf = (doc: EtlSwingDoc): string =>
  doc.labels.player_name ?? doc.labels.player_slot ?? 'unassigned';

export const strokeToApp = (s: EtlStroke | null): Stroke | null =>
  s === null ? null : ((s.charAt(0).toUpperCase() + s.slice(1)) as Stroke);

/**
 * `other` means "tagged, but not a phase boundary", which for alignment is
 * indistinguishable from untagged — the compare view can only anchor on the
 * three real phases.
 */
export const stageToPhase = (s: EtlStage | null): Phase | null =>
  s === null || s === 'other' ? null : s;

/**
 * ETL quality is 1-5, the app's grade has three values, so this is lossy by
 * construction. Documented in the spec: a quality of 1 round-trips back as 2.
 */
export const qualityToGrade = (q: number | null): Grade | null => {
  if (q === null) return null;
  if (q <= 2) return 'work';
  if (q === 3) return 'ok';
  return 'good';
};

const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** `<session>/<dir>/<file>` under the dev middleware's media route. */
export const mediaUrlFor = (session: string, dir: string, file: string): string =>
  `/api/media/${session}/${dir}/${file}`;

/**
 * One `SwingDoc` as the review UI sees it.
 *
 * EVERY extracted frame is carried, in source order: `i` is a contiguous render
 * index over the whole list and `sourceMs` is the identity that `user-edit.json`
 * joins on. Narrowing to a window is the compare grid's concern
 * (`buildCompare`), not the adapter's — sampling here made 40 of a 49-still
 * swing unreachable and silently dropped their stage tags on write-back.
 *
 * `player_slot` stands in for a name because a slot is all the pipeline can
 * honestly know; `stroke` stays null because classification is not part of the
 * ETL. Neither is a placeholder to be filled with a guess.
 */
/**
 * The two numbers the row shows, or null if the ETL did not measure them.
 *
 * `measurements` is typed as an open record because the schema marks every
 * field in it optional, so each one is checked at the value rather than trusted
 * from the type. A swing missing either number is reported as unmeasured
 * instead of half-measured: `isSuspect` needs both to say anything.
 */
function measurementsOf(doc: EtlSwingDoc): ClipMeasurements | null {
  const m = doc.measurements;
  if (m === null || typeof m !== 'object') return null;
  const speed = m.wrist_peak_speed;
  const arm = m.contact_offset;
  if (typeof speed !== 'number' || typeof arm !== 'number') return null;
  // The three below are reported, not judged, so a missing one costs only its
  // own row — unlike the two above, whose absence makes `isSuspect` unanswerable
  // and so makes the whole block unmeasured.
  return {
    wristSpeed: speed,
    armOffset: arm,
    ...(typeof m.torso_height === 'number' ? { torsoHeight: m.torso_height } : {}),
    ...(typeof m.contact_height === 'number' ? { contactHeight: m.contact_height } : {}),
    ...(m.hitting_side === 'left' || m.hitting_side === 'right'
      ? { hittingSide: m.hitting_side }
      : {}),
  };
}

/**
 * The detector's own account of this swing, unfolded.
 *
 * `??` on the two nullable fields rather than a bare read: these come off JSON
 * on disk, and a document written before a field existed omits the key entirely
 * — `onset_ms` did exactly that when re-anchoring was reverted. Absent and null
 * mean the same thing here, so both land on null.
 */
const detectionOf = (doc: EtlSwingDoc): ClipDetection => ({
  method: doc.detection.method,
  onsetPeak: doc.detection.onset_peak ?? null,
  verified: doc.detection.verified,
  rejectReason: doc.detection.reject_reason ?? null,
});

/**
 * One box off disk, or null.
 *
 * The four geometry fields are required together: a box missing `w` cannot be
 * drawn or reported, and half of one is worse than none. `conf` is carried only
 * when it is a number, matching `schema.py`, where it is present-only.
 */
function boxOf(raw: unknown): ObjectBox | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const { x, y, w, h } = b;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return null;
  }
  return { x, y, w, h, ...(typeof b.conf === 'number' ? { conf: b.conf } : {}) };
}

/**
 * The racket/ball block, or null when no detector looked.
 *
 * The two "nothing here" answers are NOT the same and this is where they part.
 * A missing or malformed `objects` returns null, which the panel reads as
 * "nobody looked" — true of every swing rendered before `--objects-backend`
 * existed. A block that IS there returns with `racket`/`ball` null, which the
 * panel reads as "looked and found nothing", the ordinary case: the racket is
 * found on 62% of swings and a ball in flight on 59%.
 */
function objectsOf(doc: EtlSwingDoc): ClipObjects | null {
  const o = doc.objects;
  if (o === null || o === undefined || typeof o !== 'object' || Array.isArray(o)) return null;

  const ball = boxOf(o.ball);
  return {
    ...(typeof o.detector === 'string' ? { detector: o.detector } : {}),
    racket: boxOf(o.racket),
    ball:
      ball === null
        ? null
        : {
            ...ball,
            ...(typeof o.ball === 'object' && o.ball !== null
              ? extras(o.ball as Record<string, unknown>)
              : {}),
          },
  };
}

/** `motion` and `racket_distance`, each carried only when measured. */
const extras = (b: Record<string, unknown>): Partial<BallBox> => ({
  ...(typeof b.motion === 'number' ? { motion: b.motion } : {}),
  ...(typeof b.racket_distance === 'number' ? { racketDistance: b.racket_distance } : {}),
});

export function adaptSwing(doc: EtlSwingDoc, mediaBase?: string): Clip {
  const measured = measurementsOf(doc);
  const objects = objectsOf(doc);
  const frames: Frame[] = doc.frames.map((f, i) => ({
    i,
    sourceMs: f.source_ms,
    // The detector's contact moment, carried so `buildCompare` can align on the
    // real contact frame rather than guessing at the midpoint of the extraction.
    offsetContactMs: f.offset_contact_ms,
    phase: stageToPhase(f.stage),
    // Omitted rather than carried as null: `poseScore` is absent on every frame
    // outside the pose window by design, and `undefined` is the shape the rest
    // of `Frame`'s optional fields already use for "the ETL had nothing here".
    ...(typeof f.pose_score === 'number' ? { poseScore: f.pose_score } : {}),
    ...(mediaBase === undefined ? {} : { imageUrl: `${mediaBase}/${f.file}` }),
  }));

  // player_slot can be null per schema.py:165, so we need a final fallback
  return {
    id: doc.id,
    player: playerOf(doc),
    stroke: strokeToApp(doc.labels.stroke),
    rejected: isRejected(doc),
    duration: formatDuration(doc.trim.source_end_ms - doc.trim.source_start_ms),
    sourceStartMs: doc.trim.source_start_ms,
    sourceEndMs: doc.trim.source_end_ms,
    contactMs: doc.detection.contact_ms,
    detection: detectionOf(doc),
    clipSize: { width: doc.trim.width, height: doc.trim.height },
    triaged: doc.edit?.reviewed === true,
    grade: qualityToGrade(doc.labels.quality),
    note: doc.labels.notes ?? '',
    frames,
    // `trim.file` rather than a hardcoded 'clip.mp4': the ETL owns the name and
    // records it, and metadata.json is the only thing entitled to say it.
    ...(mediaBase === undefined ? {} : { videoUrl: `${mediaBase}/${doc.trim.file}` }),
    ...(measured === null ? {} : { measurements: measured }),
    ...(objects === null ? {} : { objects }),
  };
}

/** A swing the read path could not adapt, and what went wrong. */
export interface SkippedSwing {
  /** Where it lives under the session, e.g. `swings/swing_007`. */
  dir: string;
  /** The adapter's own message, so a dev can tell which field was wrong. */
  reason: string;
}

export interface AdaptedSession {
  clips: Clip[];
  /**
   * Only the entries whose docs adapted. A swing with no clip is not a write
   * target: `toUserEdit` projects a `Clip` back onto its source doc, so there is
   * nothing to write for one the app could not read.
   */
  entries: SwingEntry[];
  skipped: SkippedSwing[];
}

/**
 * Every swing in a session, adapted INDIVIDUALLY.
 *
 * Individually because `adaptSwing` throws on values the ETL's types forbid but
 * `overlay()` merges in unchecked from a hand-edited `user-edit.json` — a
 * non-string `stroke` reaches `strokeToApp`'s `.charAt` and throws. This used to
 * be a `.map`, so one such swing threw for the whole payload; `loadEtlClips`
 * caught it and returned the `null` that means "there is no out/ tree", and all
 * 42 swings silently became seed data.
 *
 * So a bad document costs its own swing and nothing else, and `skipped` says
 * which — the count has to reach the reviewer, or a 41-of-42 session still reads
 * as complete.
 */
export function adaptSession(payload: SessionPayload): AdaptedSession {
  const clips: Clip[] = [];
  const entries: SwingEntry[] = [];
  const skipped: SkippedSwing[] = [];

  for (const entry of payload.swings) {
    // Read outside the try: `swings` is JSON off disk and can hold anything, so
    // reporting the failure must not throw a second time inside the catch.
    const dir = typeof entry?.dir === 'string' ? entry.dir : '(unknown)';
    try {
      clips.push(adaptSwing(entry.doc, `/api/media/${payload.session}/${dir}`));
      entries.push(entry);
    } catch (err) {
      skipped.push({ dir, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { clips, entries, skipped };
}
