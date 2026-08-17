import type { EtlFrame, EtlStroke, EtlSwingDoc } from './etl-types';
import type { Clip, Grade } from './types';

/**
 * Builds the `user-edit.json` document for one clip.
 *
 * The whole `SwingDoc` is written, not a patch: `user-edit.json` is the same
 * schema as `metadata.json` and one validator serves both. ETL-owned blocks are
 * echoed from `source` so the file stands alone; `overlay()` ignores them from
 * the edit side regardless.
 */
export function toUserEdit(
  clip: Clip,
  source: EtlSwingDoc,
  hash: string,
  by: string,
  at: string,
): EtlSwingDoc {
  const stageBySourceMs = new Map(clip.frames.map((f) => [f.sourceMs, f.phase]));

  // Only the sampled frames are written, so the 40 frames the compare grid never
  // showed keep whatever stage they already had.
  const frames: EtlFrame[] = source.frames
    .filter((f) => stageBySourceMs.has(f.source_ms))
    .map((f) => ({ ...f, stage: stageBySourceMs.get(f.source_ms) ?? null }));

  return {
    ...source,
    labels: {
      ...source.labels,
      player_name: clip.player,
      stroke: strokeToEtl(clip.stroke),
      quality: gradeToQuality(clip.grade),
      // A human calling a clip bad is a verdict; `detection` stays the ETL's.
      verdict: clip.rejected ? 'false_positive' : 'valid',
      notes: clip.note === '' ? null : clip.note,
    },
    frames,
    edit: { by, at, against: hash, reviewed: true },
  };
}

const strokeToEtl = (s: Clip['stroke']): EtlStroke | null =>
  s === null ? null : (s.toLowerCase() as EtlStroke);

/** Inverse of `qualityToGrade`, and lossy the same way: `work` writes 2. */
const gradeToQuality = (g: Grade | null): 2 | 3 | 4 | null => {
  if (g === null) return null;
  if (g === 'work') return 2;
  if (g === 'ok') return 3;
  return 4;
};
