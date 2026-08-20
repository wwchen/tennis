import type {
  EtlEdit,
  EtlFrame,
  EtlLabels,
  EtlPlayerSlot,
  EtlStage,
  EtlStroke,
  EtlSwingDoc,
  EtlVerdict,
} from './etl-types';
import {
  ETL_PLAYER_SLOTS,
  ETL_QUALITY,
  ETL_STAGES,
  ETL_STROKES,
  ETL_VERDICTS,
} from './etl-types';
import { isRejected, playerOf, qualityToGrade, stageToPhase, strokeToApp } from './etl';
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
 *
 * `by` and `at` describe *this* write; `hash` is the `doc_hash` of the ETL
 * metadata the clip was read from, and becomes `edit.against` only when the
 * write records real human work — see `editFor`.
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

  // Every human-authorable field, projected. Each `*For` below answers the same
  // question — "does the clip disagree with what the read adapter would have
  // derived from `source`?" — so this object IS the record of what changed, and
  // `changedFromSource` reads the answer off it rather than tracking it twice.
  const projected: EtlLabels = {
    ...source.labels,
    player_name: playerNameFor(clip, source),
    stroke: strokeFor(clip, source),
    quality: qualityFor(clip, source),
    // A human calling a clip bad is a verdict; `detection` stays the ETL's.
    verdict: verdictFor(clip, source),
    notes: notesFor(clip, source),
  };

  return {
    ...source,
    // Sanitised on the way out, AFTER `changedFromSource` has read the raw
    // projection: repairing a malformed file is not a review, so it must not
    // register as a human edit and re-stamp `edit.by`.
    labels: sanitiseLabels(projected),
    frames,
    edit: editFor(changedFromSource(clip, projected, source), prevEdit, hash, by, at),
  };
}

/**
 * The `edit` block to write.
 *
 * `by` is attribution and `against` is a staleness marker, and neither belongs
 * to this app unless this app's user actually did something:
 *
 *   - **The human changed nothing.** The write is the load-time write-back
 *     firing on a document some other reviewer or tool authored. Stamping `by`
 *     with the current reviewer launders the attribution, and stamping `against`
 *     with the current hash erases the one signal that says the clip was
 *     re-rendered since it was reviewed — `overlay()` warns "stale edit:
 *     reviewed against X but metadata is Y" (`schema.py:419`) precisely so a
 *     reviewer learns that. Overwriting it makes a genuinely stale review
 *     silently claim to be current, which is worse than the stale review.
 *     So both are carried through from the previous file verbatim.
 *
 *   - **The human changed something.** The labels on disk are now this
 *     reviewer's work, reviewed against the metadata they were looking at, so
 *     `by` and `against` are this write's own.
 *
 * `at` is always this write's timestamp either way: it records when the file was
 * written, and it is the one field the fixed-point property exempts.
 *
 * `reviewed` is always true — the write-back effect only fires for a triaged
 * clip, and `adaptSwing` derives `triaged` from `reviewed === true`.
 */
function editFor(
  changed: boolean,
  prevEdit: EtlSwingDoc | null,
  hash: string,
  by: string,
  at: string,
): EtlEdit {
  const prior = prevEdit?.edit ?? null;
  // A previous `by` that is not a string is not attribution, and echoing it
  // would emit a document `_check_edit` rejects.
  if (changed || prior === null || typeof prior.by !== 'string') {
    return { by, at, against: hash, reviewed: true };
  }
  // `optional=True` in `_Check.field` means "null is allowed", NOT "the key may
  // be absent" — `field()` reports `missing` before it ever looks at `optional`.
  // So `against: null` is valid and an ABSENT `against` is not: the key is always
  // written, carrying the previous value or an explicit null when there was none.
  return {
    by: prior.by,
    at,
    against: typeof prior.against === 'string' ? prior.against : null,
    reviewed: true,
  };
}

/**
 * Whether this projection records a human changing something.
 *
 * Derived from the projection rather than from a flag threaded down from the UI.
 * Each `*For` helper below already decides, field by field, whether the clip
 * disagrees with what the read adapter would have derived from `source` — that is
 * the same question — and each returns `source`'s own value verbatim when it does
 * not. So "the human changed nothing" is exactly "every projected field is
 * identical to the one it came from", and that identity is what the fixed-point
 * tests already pin. A separate flag would be a second, independent answer to the
 * same question, free to drift: the projection preserving a label while the flag
 * claims a human edited it, or the reverse.
 *
 * Frames are compared through `stageToPhase` — `adaptSwing`'s own read — rather
 * than against the written stage, because a *sanitised* stage differs from the
 * source without any human involvement, and repair is not review.
 *
 * `tags` is excluded for the same reason: nothing in the app can edit it, so a
 * difference there is only `sanitiseLabels` at work. `player_slot` is excluded
 * because it is not human-authorable at all.
 *
 * Frames re-attached by `orphanedFrames` are excluded too — carrying an entry
 * through is preservation, not authorship.
 */
function changedFromSource(clip: Clip, projected: EtlLabels, source: EtlSwingDoc): boolean {
  const before = source.labels;
  if (
    projected.player_name !== before.player_name ||
    projected.stroke !== before.stroke ||
    projected.quality !== before.quality ||
    projected.verdict !== before.verdict ||
    projected.notes !== before.notes
  ) {
    return true;
  }
  // Joined on source_ms, never index: a clip restored from an older localStorage
  // doc need not carry every frame `source` has.
  const stageBySourceMs = new Map(source.frames.map((f) => [f.source_ms, f.stage]));
  return clip.frames.some(
    (f) =>
      stageBySourceMs.has(f.sourceMs) &&
      f.phase !== stageToPhase(stageBySourceMs.get(f.sourceMs) ?? null),
  );
}

/**
 * The `labels` block, forced into something `validate_swing` accepts.
 *
 * Everything above answers "what did the human mean"; this answers the separate
 * question "is what we are about to write even legal". They are separate because
 * `source` is not trustworthy: it came out of `overlay()`, which lifts `labels`
 * out of `user-edit.json` field by field with **no validation at all**
 * (`schema.py:424`), and the app spreads `...source.labels` so anything it did not
 * project is echoed straight back. A hand-edited or foreign file could therefore
 * make `toUserEdit` emit a document the ETL's own validator rejects — the app
 * writing a file the pipeline cannot read.
 *
 * A value outside its vocabulary becomes `null`, which is what "the ETL has no
 * label here" already means and the one value every label field accepts. It is not
 * coerced towards a legal member: `stroke: "Backhand"` might plausibly mean
 * `backhand`, but `quality: 9` and `verdict: "nope"` have no defensible reading,
 * and inventing one records a call no human made — the same class of bug as §1.
 */
function sanitiseLabels(labels: EtlLabels): EtlLabels {
  return {
    ...labels,
    player_slot: isMember(ETL_PLAYER_SLOTS, labels.player_slot)
      ? labels.player_slot
      : (null as EtlPlayerSlot | null),
    player_name: typeof labels.player_name === 'string' ? labels.player_name : null,
    stroke: isMember(ETL_STROKES, labels.stroke) ? labels.stroke : null,
    // `_is` rejects a bool for an integer field and a float is not an `int`, so
    // membership in QUALITY is the whole check — `true` and `4.0` both fail it.
    quality: isMember(ETL_QUALITY, labels.quality) ? labels.quality : null,
    verdict: isMember(ETL_VERDICTS, labels.verdict) ? labels.verdict : null,
    tags: sanitiseTags(labels.tags),
    notes: typeof labels.notes === 'string' ? labels.notes : null,
  };
}

/**
 * `tags`, as a string array.
 *
 * `schema.py:172` requires a list and `schema.py:178` requires every member to be
 * a string, so `tags: "backhand"` and `tags: [1, null]` both make the document
 * invalid. Nothing in this app can author a tag, so every value here is something
 * another tool or a hand edit put on disk.
 *
 * A non-string entry is DROPPED rather than coerced. `String(1)` invents the tag
 * `"1"`, which nobody wrote and which then wins in `overlay()` (a non-empty list
 * replaces the metadata's) — a fabricated label is worse than a missing one. The
 * valid entries around it are kept, because they are real human work and the
 * whole point is to lose as little of it as possible.
 *
 * A non-array `tags` (or an absent one) becomes `[]`: there is no honest way to
 * read `"backhand"` as a list, and `[]` is what the ETL writes for "no tags".
 * Note `[]` is also the one value `overlay()` treats as "no opinion" (`if value:`),
 * so it cannot erase a `tags` list `metadata.json` carries.
 */
function sanitiseTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === 'string');
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
      // A stage outside STAGES is not human work worth carrying, and echoing it
      // would emit a document `schema.py:207` rejects. Same rule as `stageFor`.
      isMember(ETL_STAGES, f.stage),
  );
}

/**
 * Whether a value read off a `user-edit.json` is really a member of one of the
 * ETL's vocabularies.
 *
 * `EtlSwingDoc` describes what `tennisproc` writes. What actually arrives on the
 * read path has been through `overlay()`, which pulls `labels` and `frames[].stage`
 * out of `user-edit.json` field by field with no validation at all — so a value
 * the types call an `EtlStroke` may be any JSON at all, and the cast has to be
 * checked before it is echoed back.
 */
const isMember = <T extends string | number>(vocab: readonly T[], value: unknown): value is T =>
  vocab.includes(value as T);

/**
 * The stroke to write back.
 *
 * Same rule as every other field here: a stroke the clip still agrees with is
 * written back verbatim rather than round-tripped through case folding. Without
 * that, a `Stroke` whose casing does not survive `strokeToApp` → `toLowerCase`
 * exactly reads as an edit the human never made, which under `editFor` would
 * launder `edit.by` on a bare load.
 *
 * `strokeToApp` calls `.charAt`, so it is only reached for a string — a
 * non-string `stroke` on disk cannot be "unchanged" in any useful sense, and
 * `sanitiseLabels` nulls it on the way out regardless.
 */
const strokeFor = (clip: Clip, source: EtlSwingDoc): EtlStroke | null => {
  const before = source.labels.stroke;
  if (typeof before === 'string' && clip.stroke === strokeToApp(before)) return before;
  return clip.stroke === null ? null : (clip.stroke.toLowerCase() as EtlStroke);
};

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
const stageFor = (phase: Phase | null, stage: EtlStage | null): EtlStage | null => {
  // A stage outside STAGES cannot be "the source's own stage, preserved" — it is
  // a value `schema.py:207` rejects, so echoing it would emit a document the ETL
  // cannot read. `stageToPhase` only folds `null` and `other`, so `'wobble'`
  // reaches the clip as a phase, compares equal, and used to round-trip.
  if (!isMember(ETL_STAGES, stage)) return isMember(ETL_STAGES, phase) ? phase : null;
  return phase === stageToPhase(stage) ? stage : phase;
};

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
