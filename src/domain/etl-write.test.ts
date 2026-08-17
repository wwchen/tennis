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
