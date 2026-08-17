import type { EtlFrame, EtlStage, EtlStroke, EtlSwingDoc, EtlVerdict } from './etl-types';
import { isRejected, playerOf, qualityToGrade, stageToPhase } from './etl';
import type { Clip, Grade, Phase } from './types';

/**
 * Builds the `user-edit.json` document for one clip.
 *
 * The whole `SwingDoc` is written, not a patch: `user-edit.json` is the same
 * schema as `metadata.json` and one validator serves both. ETL-owned blocks are
 * echoed from `source` so the file stands alone; `overlay()` ignores them from
 * the edit side regardless.
 *
 * `source` is the document the clip was read from — the ETL's `metadata.json`
 * already merged with any previous `user-edit.json`. That makes it the reference
 * for "unchanged": every field below is written back verbatim unless the clip
 * disagrees with what the read adapter would have derived from it. Without that
 * rule the projection is lossy in both directions at once (`Grade` has three
 * values against quality's five, `rejected` is one bit against four verdicts),
 * so a bare page load rewrote a reviewer's own file with coarser labels — and
 * because a non-null value wins in `overlay()`, that loss was permanent.
 *
 * The reference is taken from `source` rather than carried on the `Clip`
 * deliberately: it needs no extra field on `Clip`, keeps the comparison against
 * what is on disk *now* rather than at page load, and cannot end up persisted
 * into localStorage as if it were coaching data.
 */
export function toUserEdit(
  clip: Clip,
  source: EtlSwingDoc,
  hash: string,
  by: string,
  at: string,
  prevEdit: EtlSwingDoc | null = null,
): EtlSwingDoc {
  const phaseBySourceMs = new Map(clip.frames.map((f) => [f.sourceMs, f.phase]));

  // Frames are joined on source_ms, never index. A frame the clip does not
  // carry is left out entirely, so it keeps whatever stage it already had —
  // reachable now only for a clip restored from an older localStorage doc,
  // since `adaptSwing` carries the full list.
  const written: EtlFrame[] = source.frames
    .filter((f) => phaseBySourceMs.has(f.source_ms))
    .map((f) => ({ ...f, stage: stageFor(phaseBySourceMs.get(f.source_ms) ?? null, f.stage) }));

  const frames = [...orphanedFrames(source, prevEdit), ...written].sort(
    (a, b) => a.source_ms - b.source_ms,
  );

  return {
    ...source,
    labels: {
      ...source.labels,
      player_name: playerNameFor(clip, source),
      stroke: strokeToEtl(clip.stroke),
      quality: qualityFor(clip, source),
      // A human calling a clip bad is a verdict; `detection` stays the ETL's.
      verdict: verdictFor(clip, source),
      notes: notesFor(clip, source),
    },
    frames,
    edit: { by, at, against: hash, reviewed: true },
  };
}

/**
 * Frame entries the previous `user-edit.json` carries that `metadata.json` has
 * no matching `source_ms` for.
 *
 * `overlay()` (`schema.py:439`) drops these from the MERGED view and warns —
 * deliberately, and it leaves them ON DISK, so re-extracting back at the
 * original `--fps` recovers whatever a human tagged there. `source` here is that
 * merged view, so a projection built only from it cannot see them; writing the
 * result back deleted them permanently, from a bare page load with no user
 * action. That is exactly the failure the ETL's "stable keys, never array
 * indices" doctrine exists to prevent.
 *
 * Only entries with a `source_ms` the metadata does not know are carried: one
 * the metadata does know is regenerated from `source` above, with the clip's
 * current stage on it.
 *
 * And only entries carrying a `stage`. An orphan's `file` points at a still the
 * current extraction did not write, and `session.validate_tree` reports a frame
 * whose file is missing — so carrying a stage-less orphan would trade a silent
 * data loss for a permanent validation complaint about an entry holding no human
 * work at all. A stage is the only thing on a frame a reviewer can author, so
 * that is exactly the set worth keeping. `overlay()` ignores a null stage
 * regardless (`schema.py:444`), so nothing is lost by dropping them.
 */
function orphanedFrames(source: EtlSwingDoc, prevEdit: EtlSwingDoc | null): EtlFrame[] {
  // `prevEdit` crosses the wire from the dev middleware, so treat a missing
  // value and a missing `frames` list the same as "no previous edit".
  if (prevEdit === null || prevEdit === undefined || !Array.isArray(prevEdit.frames)) return [];
  const known = new Set(source.frames.map((f) => f.source_ms));
  return prevEdit.frames.filter(
    (f) =>
      typeof f?.source_ms === 'number' &&
      !known.has(f.source_ms) &&
      f.stage !== null &&
      f.stage !== undefined,
  );
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

/**
 * The rating to write back.
 *
 * `gradeToQuality` can only emit 2, 3 or 4, so a grade the reviewer actually set
 * collapses 1 onto 2 and 5 onto 4. The spec sanctions that one lossy mapping and
 * documents it. What it does not sanction is applying it to a rating the reviewer
 * never touched, which is what silently rewrote a hand-set `quality: 5` as 4 on
 * page load. A grade still equal to the source's own is left alone.
 */
const qualityFor = (clip: Clip, source: EtlSwingDoc): EtlSwingDoc['labels']['quality'] =>
  clip.grade === qualityToGrade(source.labels.quality)
    ? source.labels.quality
    : gradeToQuality(clip.grade);

/**
 * The verdict to write back.
 *
 * The UI offers one bit — removed or not — against four verdicts, so the bit
 * alone cannot say which verdict a reviewer meant. It can say whether they
 * changed their mind:
 *
 *   unchanged            -> the source's verdict, whatever it was. `duplicate`
 *                           stays `duplicate`, `unclear` stays `unclear`, and a
 *                           `null` the ETL left stays `null` rather than
 *                           becoming an accept call no human made.
 *   newly rejected       -> `false_positive`, the only rejecting verdict the app
 *                           can mean on its own.
 *   newly un-rejected    -> `valid`. The human made an accept call, and leaving
 *                           `duplicate` in place would re-hide the clip on the
 *                           next load.
 */
const verdictFor = (clip: Clip, source: EtlSwingDoc): EtlVerdict | null => {
  if (clip.rejected === isRejected(source)) return source.labels.verdict;
  return clip.rejected ? 'false_positive' : 'valid';
};

/**
 * The stage to write back on one frame.
 *
 * `stageToPhase` folds `other` onto `null`, so a null phase is ambiguous between
 * "untagged" and "tagged, but not a phase boundary". Same rule as everywhere
 * else here: if the clip still agrees with the source, the source's own stage is
 * written rather than the folded value.
 */
const stageFor = (phase: Phase | null, stage: EtlStage | null): EtlStage | null =>
  phase === stageToPhase(stage) ? stage : phase;

/**
 * The note to write back.
 *
 * `adaptSwing` reads a null note as `''` so the textarea has a value to bind, so
 * an untouched note must write back as whatever it was — otherwise an empty
 * string the reviewer never typed replaces a null, or the reverse.
 */
const notesFor = (clip: Clip, source: EtlSwingDoc): string | null => {
  if (clip.note === (source.labels.notes ?? '')) return source.labels.notes;
  return clip.note === '' ? null : clip.note;
};

/**
 * The player name to write back, or null when nobody has named one.
 *
 * `adaptSwing` falls back to `player_slot` and then to `'unassigned'` so the UI
 * has something to show. Writing that back claims a human named the player after
 * a court zone, which is exactly the confusion the schema keeps `player_slot`
 * and `player_name` separate to avoid.
 */
const playerNameFor = (clip: Clip, source: EtlSwingDoc): string | null =>
  clip.player === playerOf(source) ? source.labels.player_name : clip.player;
