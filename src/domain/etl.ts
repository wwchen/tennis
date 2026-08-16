import type {
  EtlFrame,
  EtlStage,
  EtlStroke,
  EtlSwingDoc,
  SessionPayload,
} from './etl-types';
import type { Clip, Frame, Grade, Phase, Stroke } from './types';

/** Offsets, in frames, that the compare grid samples around contact. */
const WINDOW = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

/** Source frame interval at 30 fps. Real output steps 33 ms. */
const DEFAULT_STEP_MS = 33;

/**
 * Narrows a swing's 42-49 stills to the compare grid's width, centred on
 * contact so `buildCompare` can align every row on the same column.
 *
 * Contact is selected first and never dropped: the other targets are resolved
 * around it, and duplicates are removed by `source_ms`, so a sparse swing
 * yields fewer than nine frames rather than the same frame twice.
 */
export function sampleFrames(
  frames: EtlFrame[],
  contactMs: number,
  stepMs: number = DEFAULT_STEP_MS,
): EtlFrame[] {
  if (frames.length === 0) return [];

  const nearest = (targetMs: number): EtlFrame =>
    frames.reduce((best, f) =>
      Math.abs(f.source_ms - targetMs) < Math.abs(best.source_ms - targetMs) ? f : best,
    );

  const picked = new Map<number, EtlFrame>();
  const contact = nearest(contactMs);
  picked.set(contact.source_ms, contact);

  for (const k of WINDOW) {
    if (k === 0) continue;
    const f = nearest(contactMs + k * stepMs);
    if (!picked.has(f.source_ms)) picked.set(f.source_ms, f);
  }

  return [...picked.values()].sort((a, b) => a.source_ms - b.source_ms);
}

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
 * `player_slot` stands in for a name because a slot is all the pipeline can
 * honestly know; `stroke` stays null because classification is not part of the
 * ETL. Neither is a placeholder to be filled with a guess.
 */
export function adaptSwing(doc: EtlSwingDoc, mediaBase?: string): Clip {
  const sampled = sampleFrames(doc.frames, doc.detection.contact_ms);

  const frames: Frame[] = sampled.map((f, i) => ({
    i,
    sourceMs: f.source_ms,
    phase: stageToPhase(f.stage),
    ...(mediaBase === undefined ? {} : { imageUrl: `${mediaBase}/${f.file}` }),
  }));

  const rejected =
    !doc.detection.verified ||
    doc.labels.verdict === 'false_positive' ||
    doc.labels.verdict === 'duplicate';

  // player_slot can be null per schema.py:165, so we need a final fallback
  return {
    id: doc.id,
    player: doc.labels.player_name ?? doc.labels.player_slot ?? 'unassigned',
    stroke: strokeToApp(doc.labels.stroke),
    rejected,
    duration: formatDuration(doc.trim.source_end_ms - doc.trim.source_start_ms),
    triaged: doc.edit?.reviewed === true,
    grade: qualityToGrade(doc.labels.quality),
    note: doc.labels.notes ?? '',
    frames,
  };
}

export const adaptSession = (payload: SessionPayload): Clip[] =>
  payload.swings.map((entry) =>
    adaptSwing(entry.doc, `/api/media/${payload.session}/${entry.dir}`),
  );
