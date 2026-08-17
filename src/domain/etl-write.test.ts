import { describe, expect, it } from 'vitest';
import realSwing from './__fixtures__/swing-real.json';
import type { EtlSwingDoc } from './etl-types';
import { adaptSwing } from './etl';
import { toUserEdit } from './etl-write';

const source = realSwing as unknown as EtlSwingDoc;
const AT = '2026-08-16T12:00:00Z';

describe('toUserEdit', () => {
  it('writes the human labels a reviewer set', () => {
    const clip = { ...adaptSwing(source), stroke: 'Backhand' as const, grade: 'good' as const, note: 'late' };
    expect(source.labels.quality).toBeNull();
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.stroke).toBe('backhand');
    expect(doc.labels.quality).toBe(4);
    expect(doc.labels.notes).toBe('late');
    expect(doc.edit).toEqual({ by: 'wc', at: AT, against: 'sha256:abc', reviewed: true });
  });

  it('echoes ETL-owned blocks unchanged so the file is a standalone SwingDoc', () => {
    const doc = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT);
    expect(doc.schema).toBe('tennis.swing/1');
    expect(doc.id).toBe(source.id);
    expect(doc.trim).toEqual(source.trim);
    expect(doc.detection).toEqual(source.detection);
    expect(doc.measurements).toEqual(source.measurements);
  });

  it('keys frames on source_ms and writes every frame the clip carries', () => {
    // Updated from the old 9-frame contract: `adaptSwing` no longer samples, so
    // all 49 stills round-trip and a tag on any of them survives.
    const clip = adaptSwing(source);
    clip.frames[24] = { ...clip.frames[24], phase: 'contact' };
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.frames).toHaveLength(49);
    expect(doc.frames.map((f) => f.source_ms)).toEqual(source.frames.map((f) => f.source_ms));
    const contact = doc.frames.find((f) => f.source_ms === 6301);
    expect(contact?.stage).toBe('contact');
  });

  it('carries a stage tagged far outside the compare window', () => {
    // Frame 2 is 734 ms before contact — unreachable under the old 9-frame
    // sample, and the tag was dropped on write-back even if it existed on disk.
    const clip = adaptSwing(source);
    clip.frames[2] = { ...clip.frames[2], phase: 'setup' };
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    const tagged = doc.frames.filter((f) => f.stage !== null);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].source_ms).toBe(source.frames[2].source_ms);
    expect(tagged[0].stage).toBe('setup');
  });

  it('records a newly rejected clip as false_positive, not by editing detection', () => {
    const doc = toUserEdit({ ...adaptSwing(source), rejected: true }, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.verdict).toBe('false_positive');
    expect(doc.detection.verified).toBe(true);
  });
});

describe('frames orphaned by a re-extraction', () => {
  /**
   * `overlay()` (schema.py:439) drops a frame whose `source_ms` metadata does
   * not know about FROM THE MERGED VIEW, and warns — but deliberately leaves it
   * ON DISK, so re-running the ETL back at the original `--fps` recovers
   * whatever a human tagged there. `source` is that merged view, so a projection
   * built only from it cannot see those entries; writing the result back deleted
   * them permanently, from a bare page load with no user action.
   */
  const ORPHAN_MS = 6317; // between two real frames, so no --fps grid contains both

  /** A previous `user-edit.json` carrying a stage the metadata cannot place. */
  const prevEdit = (): EtlSwingDoc => ({
    ...source,
    frames: [
      { ...source.frames[0] },
      {
        file: 'frames/frame_0099.jpg',
        source_ms: ORPHAN_MS,
        clip_ms: 816,
        offset_contact_ms: 16,
        pose_score: null,
        stage: 'contact',
      },
    ],
    edit: { by: 'wc', at: '2026-08-15T09:00:00Z', against: 'sha256:abc', reviewed: true },
  });

  it('survives a load-only write instead of being erased from disk', () => {
    const disk = prevEdit();
    // The merged doc the UI reads has no such frame — that is the whole problem.
    expect(source.frames.some((f) => f.source_ms === ORPHAN_MS)).toBe(false);

    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT, disk);

    const orphan = written.frames.find((f) => f.source_ms === ORPHAN_MS);
    expect(orphan).toBeDefined();
    expect(orphan?.stage).toBe('contact');
    // Every real frame is still written too, so nothing is traded away for it.
    expect(written.frames).toHaveLength(50);
  });

  it('keeps the frame list sorted by source_ms so the schema still accepts it', () => {
    // schema.py:206 requires source_ms strictly increasing: overlay() joins on
    // it, so an out-of-order or duplicated entry makes a human's stage
    // ambiguous. Appending the orphan blindly would land it after frame 49.
    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT, prevEdit());
    const ms = written.frames.map((f) => f.source_ms);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(new Set(ms).size).toBe(ms.length);
  });

  it('does not duplicate a frame the metadata does know about', () => {
    // The first entry of `prevEdit` is a real frame. It has to come from
    // `source` with the clip's current stage, not be carried through twice.
    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT, prevEdit());
    const first = written.frames.filter((f) => f.source_ms === source.frames[0].source_ms);
    expect(first).toHaveLength(1);
    expect(written.frames).toHaveLength(50);
  });

  it('is a no-op when there is no previous edit on disk', () => {
    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT, null);
    expect(written.frames).toHaveLength(49);
    expect({ ...written, edit: null }).toEqual({ ...source, edit: null });
  });

  it('drops an orphan carrying no stage, which holds no human work', () => {
    // An orphan's `file` names a still the current extraction did not write, and
    // `session.validate_tree` flags a frame whose file is missing. A stage is the
    // only thing on a frame a reviewer can author, so keeping a stage-less orphan
    // would trade a silent data loss for a permanent validation complaint about
    // nothing. `overlay()` ignores a null stage anyway.
    const stageless: EtlSwingDoc = {
      ...source,
      frames: [
        {
          file: 'frames/frame_0099.jpg',
          source_ms: ORPHAN_MS,
          clip_ms: 816,
          offset_contact_ms: 16,
          pose_score: null,
          stage: null,
        },
      ],
    };
    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT, stageless);
    expect(written.frames).toHaveLength(49);
    expect(written.frames.some((f) => f.source_ms === ORPHAN_MS)).toBe(false);
  });

  it('still writes the reviewer’s own new tag alongside a preserved orphan', () => {
    const clip = adaptSwing(source);
    clip.frames[2] = { ...clip.frames[2], phase: 'setup' };
    const written = toUserEdit(clip, source, 'sha256:abc', 'wc', AT, prevEdit());

    const tagged = written.frames.filter((f) => f.stage !== null);
    expect(tagged.map((f) => [f.source_ms, f.stage])).toEqual([
      [source.frames[2].source_ms, 'setup'],
      [ORPHAN_MS, 'contact'],
    ]);
  });
});

/** A source doc as it comes back from `readSession` with an edit overlaid. */
const withLabels = (labels: Partial<EtlSwingDoc['labels']>): EtlSwingDoc => ({
  ...source,
  labels: { ...source.labels, ...labels },
});

describe('verdict round trip', () => {
  it('leaves a null verdict null when the reviewer has not acted', () => {
    // The worst of the old collapses: a non-null value wins in overlay(), so
    // writing `valid` here permanently overwrote the ETL's own null with an
    // accept call no human made — on every triaged clip, from a bare page load.
    expect(source.labels.verdict).toBeNull();
    const doc = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.verdict).toBeNull();
  });

  it('preserves duplicate on a clip that is still rejected', () => {
    const dupe = withLabels({ verdict: 'duplicate' });
    const clip = adaptSwing(dupe);
    expect(clip.rejected).toBe(true);
    expect(toUserEdit(clip, dupe, 'sha256:abc', 'wc', AT).labels.verdict).toBe('duplicate');
  });

  it('preserves unclear on a clip that is still not rejected', () => {
    const unclear = withLabels({ verdict: 'unclear' });
    const clip = adaptSwing(unclear);
    expect(clip.rejected).toBe(false);
    expect(toUserEdit(clip, unclear, 'sha256:abc', 'wc', AT).labels.verdict).toBe('unclear');
  });

  it('preserves valid on a clip that is still not rejected', () => {
    const valid = withLabels({ verdict: 'valid' });
    expect(toUserEdit(adaptSwing(valid), valid, 'sha256:abc', 'wc', AT).labels.verdict).toBe('valid');
  });

  it('writes valid when the reviewer un-rejects a duplicate', () => {
    // The accept call is real, and leaving `duplicate` would re-hide the clip on
    // the next load.
    const dupe = withLabels({ verdict: 'duplicate' });
    const restored = { ...adaptSwing(dupe), rejected: false };
    expect(toUserEdit(restored, dupe, 'sha256:abc', 'wc', AT).labels.verdict).toBe('valid');
  });

  it('respects detection.verified as a rejecting state of its own', () => {
    // `adaptSwing` rejects an unverified swing regardless of verdict, so the
    // "unchanged" comparison has to use the same rule or every unverified clip
    // reads as newly un-rejected and gets stamped `valid`.
    const unverified: EtlSwingDoc = {
      ...source,
      detection: { ...source.detection, verified: false },
    };
    const clip = adaptSwing(unverified);
    expect(clip.rejected).toBe(true);
    expect(toUserEdit(clip, unverified, 'sha256:abc', 'wc', AT).labels.verdict).toBeNull();
  });
});

describe('an unverified swing’s reject state converges', () => {
  /**
   * The state machine that never settled. `detection.verified` is ETL-owned, so
   * with `!verified` ORed in unconditionally an unverified swing ALWAYS read as
   * rejected: "restore" wrote `valid`, the next load re-rejected it, and a
   * subsequent "remove" wrote `valid` again — recording the reviewer's rejection
   * as an acceptance, which is the opposite of what they clicked.
   */
  const unverified = (): EtlSwingDoc => ({
    ...source,
    detection: { ...source.detection, verified: false },
    edit: null,
  });

  /** One page load: overlay the edit's labels onto the ETL doc, as `readSession` does. */
  const reload = (metadata: EtlSwingDoc, written: EtlSwingDoc): EtlSwingDoc => ({
    ...metadata,
    labels: { ...metadata.labels, verdict: written.labels.verdict },
    edit: written.edit,
  });

  it('restore → reload → remove records the rejection, not an acceptance', () => {
    const disk = unverified();

    // Load 1: the ETL rejected it and no human has said otherwise.
    const first = adaptSwing(disk);
    expect(first.rejected).toBe(true);

    // The reviewer restores it. That is an explicit accept call.
    const restored = toUserEdit({ ...first, rejected: false }, disk, 'sha256:abc', 'wc', AT);
    expect(restored.labels.verdict).toBe('valid');

    // Load 2: it must now read as NOT rejected, or the click was pointless.
    const afterReload = adaptSwing(reload(disk, restored));
    expect(afterReload.rejected).toBe(false);

    // The reviewer changes their mind and removes it. This has to record a
    // REJECTING verdict — writing `valid` here was the bug.
    const removed = toUserEdit(
      { ...afterReload, rejected: true },
      reload(disk, restored),
      'sha256:abc',
      'wc',
      AT,
    );
    expect(removed.labels.verdict).toBe('false_positive');
    expect(adaptSwing(reload(disk, removed)).rejected).toBe(true);
  });

  it('does not oscillate: each state is a fixed point under a bare reload', () => {
    const disk = unverified();
    for (const verdict of ['valid', 'false_positive'] as const) {
      const written: EtlSwingDoc = { ...disk, labels: { ...disk.labels, verdict } };
      const clip = adaptSwing(written);
      // A load-only write must not flip the verdict it just read.
      const again = toUserEdit(clip, written, 'sha256:abc', 'wc', AT);
      expect(again.labels.verdict, verdict).toBe(verdict);
      expect(adaptSwing(again).rejected).toBe(clip.rejected);
    }
  });

  it('leaves detection.verified alone throughout — it stays the ETL’s', () => {
    const disk = unverified();
    const restored = toUserEdit(
      { ...adaptSwing(disk), rejected: false },
      disk,
      'sha256:abc',
      'wc',
      AT,
    );
    expect(restored.detection.verified).toBe(false);
  });
});

describe('quality round trip', () => {
  it('leaves an untouched 5 as 5', () => {
    // gradeToQuality can only emit 2, 3 or 4, so projecting an untouched rating
    // through it rewrote a reviewer's own 5 as 4.
    const rated = withLabels({ quality: 5 });
    const clip = adaptSwing(rated);
    expect(clip.grade).toBe('good');
    expect(toUserEdit(clip, rated, 'sha256:abc', 'wc', AT).labels.quality).toBe(5);
  });

  it('leaves an untouched 1 as 1', () => {
    const rated = withLabels({ quality: 1 });
    const clip = adaptSwing(rated);
    expect(clip.grade).toBe('work');
    expect(toUserEdit(clip, rated, 'sha256:abc', 'wc', AT).labels.quality).toBe(1);
  });

  it('leaves an untouched null null', () => {
    expect(toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT).labels.quality).toBeNull();
  });

  it('does not collapse a grade the human merely re-affirmed', () => {
    // Re-picking the chip already shown clears the rating (by design), and
    // picking it again re-rates. `source` is the document the clip was READ
    // from, so it still carries the 5 throughout — the round trip has to come
    // back to 5, not to the collapsed 4.
    for (const [quality, grade] of [
      [5, 'good'],
      [1, 'work'],
    ] as const) {
      const disk = withLabels({ quality });
      const clip = adaptSwing(disk);
      expect(clip.grade).toBe(grade);

      // Click 1: clears. Click 2: re-affirms.
      const cleared = toUserEdit({ ...clip, grade: null }, disk, 'sha256:abc', 'wc', AT);
      expect(cleared.labels.quality, `cleared ${quality}`).toBeNull();
      const reaffirmed = toUserEdit({ ...clip, grade }, disk, 'sha256:abc', 'wc', AT);
      expect(reaffirmed.labels.quality, `re-affirmed ${quality}`).toBe(quality);
    }
  });

  it('returns to the exact value after the grade is changed away and back', () => {
    const disk = withLabels({ quality: 5 });
    const clip = adaptSwing(disk);
    expect(toUserEdit({ ...clip, grade: 'ok' }, disk, 'sha256:abc', 'wc', AT).labels.quality).toBe(3);
    // Back to what is on disk: the 5 must come back, not 4.
    expect(toUserEdit({ ...clip, grade: 'good' }, disk, 'sha256:abc', 'wc', AT).labels.quality).toBe(5);
  });

  it('collapses a grade the human actually set onto 2, 3 or 4', () => {
    // The one lossy mapping the spec sanctions: `work` writes 2, so a 1 the
    // reviewer re-picked as "work" comes back as 2.
    const rated = withLabels({ quality: 5 });
    const clip = adaptSwing(rated);
    for (const [grade, quality] of [
      ['work', 2],
      ['ok', 3],
      ['good', 4],
    ] as const) {
      // 'good' is what a 5 already reads as, so it needs a source that differs.
      const from = grade === 'good' ? withLabels({ quality: 2 }) : rated;
      const edited = { ...adaptSwing(from), grade };
      expect(toUserEdit(edited, from, 'sha256:abc', 'wc', AT).labels.quality).toBe(quality);
    }
    expect(toUserEdit({ ...clip, grade: null }, rated, 'sha256:abc', 'wc', AT).labels.quality).toBeNull();
  });
});

describe('player_name round trip', () => {
  it('writes null when nobody has named a player', () => {
    // clip.player falls back to player_slot, so writing it back told the ETL a
    // human named this player "left" — a court zone, not a person.
    const clip = adaptSwing(source);
    expect(clip.player).toBe('left');
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.player_name).toBeNull();
    expect(doc.labels.player_slot).toBe('left');
  });

  it('writes null when there is not even a slot to fall back to', () => {
    const anon = withLabels({ player_slot: null });
    const clip = adaptSwing(anon);
    expect(clip.player).toBe('unassigned');
    expect(toUserEdit(clip, anon, 'sha256:abc', 'wc', AT).labels.player_name).toBeNull();
  });

  it('writes the real name when a human set one', () => {
    const named = { ...adaptSwing(source), player: 'Coach Ana' };
    const doc = toUserEdit(named, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.player_name).toBe('Coach Ana');
    expect(doc.labels.player_slot).toBe('left');
  });

  it('preserves a name that was already on disk', () => {
    const named = withLabels({ player_name: 'Coach Ana' });
    const clip = adaptSwing(named);
    expect(clip.player).toBe('Coach Ana');
    expect(toUserEdit(clip, named, 'sha256:abc', 'wc', AT).labels.player_name).toBe('Coach Ana');
  });
});

describe('notes round trip', () => {
  it('leaves an untouched null note null rather than writing an empty string', () => {
    expect(source.labels.notes).toBeNull();
    expect(toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT).labels.notes).toBeNull();
  });

  it('clears a note the reviewer emptied', () => {
    const noted = withLabels({ notes: 'late' });
    const cleared = { ...adaptSwing(noted), note: '' };
    expect(toUserEdit(cleared, noted, 'sha256:abc', 'wc', AT).labels.notes).toBeNull();
  });

  it('round-trips an on-disk empty string as an empty string, not null', () => {
    // The one case `notesFor` exists for, and the only one where it differs from
    // the old projection: the fixture has `notes: null` and `clip.note` is `''`,
    // so every other test agrees either way. `adaptSwing` reads null as `''` for
    // the textarea to bind, which makes `''` on the clip ambiguous — an on-disk
    // `''` must not silently become null on a bare load.
    const empty = withLabels({ notes: '' });
    const clip = adaptSwing(empty);
    expect(clip.note).toBe('');
    expect(toUserEdit(clip, empty, 'sha256:abc', 'wc', AT).labels.notes).toBe('');
  });

  it('writes null when a human clears a real note, not an empty string', () => {
    // The other side of the same ambiguity: here `''` IS a human action, and the
    // schema's way to say "no note" is null.
    const noted = withLabels({ notes: 'shanked' });
    const cleared = { ...adaptSwing(noted), note: '' };
    const written = toUserEdit(cleared, noted, 'sha256:abc', 'wc', AT);
    expect(written.labels.notes).toBeNull();
    expect(written.labels.notes).not.toBe('');
  });
});

describe('stage round trip', () => {
  it('keeps an ETL stage of "other" rather than folding it to null', () => {
    // stageToPhase folds `other` onto null, so a null phase is ambiguous. The
    // source's own stage wins when the clip still agrees with it.
    const frames = source.frames.map((f, i) => (i === 3 ? { ...f, stage: 'other' as const } : f));
    const withOther: EtlSwingDoc = { ...source, frames };
    const clip = adaptSwing(withOther);
    expect(clip.frames[3].phase).toBeNull();
    const doc = toUserEdit(clip, withOther, 'sha256:abc', 'wc', AT);
    expect(doc.frames[3].stage).toBe('other');
  });

  it('clears a stage the reviewer untagged', () => {
    const frames = source.frames.map((f, i) => (i === 3 ? { ...f, stage: 'setup' as const } : f));
    const tagged: EtlSwingDoc = { ...source, frames };
    const clip = adaptSwing(tagged);
    expect(clip.frames[3].phase).toBe('setup');
    const untagged = {
      ...clip,
      frames: clip.frames.map((f, i) => (i === 3 ? { ...f, phase: null } : f)),
    };
    expect(toUserEdit(untagged, tagged, 'sha256:abc', 'wc', AT).frames[3].stage).toBeNull();
  });
});

describe('load-only round trip is a fixed point', () => {
  /**
   * The regression test for §1 of the follow-ups spec, and the property the
   * whole task exists to establish: a page load with no user action must write
   * back something byte-identical to what is already on disk, apart from
   * `edit.at`. Anything less and a second review pass over the same tree
   * silently degrades the first pass's labels, permanently — a non-null value
   * wins in `overlay()`, so the loss cannot be undone by re-reading.
   */
  const onDisk = (): EtlSwingDoc => ({
    ...source,
    labels: {
      ...source.labels,
      quality: 5,
      verdict: 'duplicate',
      player_name: null,
      stroke: 'backhand',
      notes: 'shanked, keep for the reel',
      tags: ['reel'],
    },
    // A stage well outside the old 9-frame window, at both ends.
    frames: source.frames.map((f, i) => {
      if (i === 2) return { ...f, stage: 'setup' as const };
      if (i === 46) return { ...f, stage: 'finish' as const };
      return f;
    }),
    edit: { by: 'wc', at: '2026-08-15T09:00:00Z', against: 'sha256:abc', reviewed: true },
  });

  it('rewrites a reviewer’s own file byte-identically apart from edit.at', () => {
    const disk = onDisk();
    // What the read path produces (readSession -> overlayEdit -> adaptSwing) and
    // what the load-time write-back effect then sends, with no user action.
    const written = toUserEdit(adaptSwing(disk), disk, 'sha256:abc', 'wc', '2026-08-16T12:00:00Z');

    expect({ ...written, edit: null }).toEqual({ ...disk, edit: null });
    expect(JSON.stringify({ ...written, edit: null })).toBe(
      JSON.stringify({ ...disk, edit: null }),
    );
    expect(written.edit).toEqual({
      by: 'wc',
      at: '2026-08-16T12:00:00Z',
      against: 'sha256:abc',
      reviewed: true,
    });
  });

  it('preserves each of the four fields the old projection degraded', () => {
    const disk = onDisk();
    const written = toUserEdit(adaptSwing(disk), disk, 'sha256:abc', 'wc', AT);

    // quality 5 -> 4, verdict duplicate -> false_positive,
    // player_name null -> "left", and the two far stage tags dropped.
    expect(written.labels.quality).toBe(5);
    expect(written.labels.verdict).toBe('duplicate');
    expect(written.labels.player_name).toBeNull();
    expect(written.frames).toHaveLength(49);
    expect(written.frames[2].stage).toBe('setup');
    expect(written.frames[46].stage).toBe('finish');
  });

  it('is idempotent: writing the written document changes nothing further', () => {
    const disk = onDisk();
    const once = toUserEdit(adaptSwing(disk), disk, 'sha256:abc', 'wc', AT);
    const twice = toUserEdit(adaptSwing(once), once, 'sha256:abc', 'wc', AT);
    expect(twice).toEqual(once);
  });

  it('holds for the untouched ETL fixture too, where every label is null', () => {
    const written = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT);
    expect({ ...written, edit: null }).toEqual({ ...source, edit: null });
  });
});
