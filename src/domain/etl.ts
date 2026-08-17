import type {
  EtlFrame,
  EtlStage,
  EtlStroke,
  EtlSwingDoc,
  SessionPayload,
} from './etl-types';
import type { Clip, Frame, Grade, Phase, Stroke } from './types';
import { frameWindow } from './window';

/**
 * The compare grid's window over a swing's 42-49 stills, in `source_ms` space:
 * the run of frames the aligned view can show at once, centred on contact.
 *
 * NOT used by `adaptSwing` — a `Clip` carries every frame, and `buildCompare`
 * applies `frameWindow` in index space. This is the same window expressed
 * against raw ETL frames, for callers that hold a `contact_ms` rather than a
 * frame index. Both go through `frameWindow`, so there is one definition.
 *
 * Contact is never dropped: the window always contains its anchor, and the
 * frames come back in `source_ms` order without repeats because they are a
 * contiguous slice of a list the schema requires to be strictly increasing.
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

  const { start, end } = frameWindow(frames.length, contact);
  return frames.slice(start, end);
}

/**
 * Whether the ETL's own output already calls this clip unusable.
 *
 * Shared with `etl-write.ts`: write-back has to tell a verdict the reviewer set
 * from the one it read, and it can only do that against the same rule the read
 * adapter applied.
 */
export const isRejected = (doc: EtlSwingDoc): boolean =>
  !doc.detection.verified ||
  doc.labels.verdict === 'false_positive' ||
  doc.labels.verdict === 'duplicate';

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
 * (`buildCompare`), not the adapter's — sampling here made 40 of 49 stills
 * unreachable and silently dropped their stage tags on write-back.
 *
 * `player_slot` stands in for a name because a slot is all the pipeline can
 * honestly know; `stroke` stays null because classification is not part of the
 * ETL. Neither is a placeholder to be filled with a guess.
 */
export function adaptSwing(doc: EtlSwingDoc, mediaBase?: string): Clip {
  const frames: Frame[] = doc.frames.map((f, i) => ({
    i,
    sourceMs: f.source_ms,
    phase: stageToPhase(f.stage),
    ...(mediaBase === undefined ? {} : { imageUrl: `${mediaBase}/${f.file}` }),
  }));

  // player_slot can be null per schema.py:165, so we need a final fallback
  return {
    id: doc.id,
    player: playerOf(doc),
    stroke: strokeToApp(doc.labels.stroke),
    rejected: isRejected(doc),
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
