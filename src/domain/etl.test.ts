import { describe, expect, it } from 'vitest';
import realSwing from './__fixtures__/swing-real.json';
import type { EtlSwingDoc, SessionPayload, SwingEntry } from './etl-types';
import { clipLength, sourceEnd, sourceRange, sourceStart } from './types';
import {
  adaptSession,
  adaptSwing,
  isRejected,
  qualityToGrade,
  sampleFrames,
  stageToPhase,
  strokeToApp,
} from './etl';
import { FRAMES_PER_CLIP } from './types';

const fixture = realSwing as unknown as EtlSwingDoc;

describe('sampleFrames', () => {
  it('spreads its 9 frames over the whole swing, not a third of a second', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    expect(picked).toHaveLength(FRAMES_PER_CLIP);
    // Verified against the real fixture: contact_ms 6301, 33 ms frame step, 49
    // stills spanning ±800 ms. Adjacent frames would be -133..+133 — the racket
    // passing through the ball, with the setup and the finish never shown.
    expect(picked.map((f) => f.offset_contact_ms)).toEqual([
      -800, -600, -400, -200, 0, 200, 400, 600, 800,
    ]);
    expect(picked.map((f) => f.source_ms)).toEqual([
      5501, 5701, 5901, 6101, 6301, 6501, 6701, 6901, 7101,
    ]);
  });

  it('always includes the contact frame', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    expect(picked.filter((f) => f.offset_contact_ms === 0)).toHaveLength(1);
  });

  it('de-duplicates rather than repeating a frame when the swing is sparse', () => {
    const sparse = [
      { ...fixture.frames[0], source_ms: 1000, offset_contact_ms: -200 },
      { ...fixture.frames[1], source_ms: 1200, offset_contact_ms: 0 },
      { ...fixture.frames[2], source_ms: 1400, offset_contact_ms: 200 },
    ];
    const picked = sampleFrames(sparse, 1200);
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(new Set(picked.map((f) => f.source_ms)).size).toBe(picked.length);
  });

  it('returns frames in ascending source_ms', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    const ms = picked.map((f) => f.source_ms);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });
});

describe('enum mapping', () => {
  it('capitalises every ETL stroke and keeps null null', () => {
    expect(strokeToApp('forehand')).toBe('Forehand');
    expect(strokeToApp('overhead')).toBe('Overhead');
    expect(strokeToApp('other')).toBe('Other');
    expect(strokeToApp(null)).toBeNull();
  });

  it('maps stage other to no phase', () => {
    expect(stageToPhase('contact')).toBe('contact');
    expect(stageToPhase('other')).toBeNull();
    expect(stageToPhase(null)).toBeNull();
  });

  it('folds 1-5 quality onto the three grades', () => {
    expect(qualityToGrade(1)).toBe('work');
    expect(qualityToGrade(2)).toBe('work');
    expect(qualityToGrade(3)).toBe('ok');
    expect(qualityToGrade(4)).toBe('good');
    expect(qualityToGrade(5)).toBe('good');
    expect(qualityToGrade(null)).toBeNull();
  });
});

describe('adaptSwing', () => {
  it('carries the real id, slot name and frame identity through', () => {
    const clip = adaptSwing(fixture);
    expect(clip.id).toBe('IMG_0304/swing_001');
    // player_name is null in ETL output, so the court zone stands in.
    expect(clip.player).toBe('left');
    expect(clip.stroke).toBeNull();
    expect(clip.frames[24].sourceMs).toBe(6301);
  });

  it('carries EVERY extracted frame, not the compare grid’s window', () => {
    // The old contract sampled to FRAMES_PER_CLIP here, which put 40 of the 49
    // stills out of the UI's reach entirely: a reviewer could not tag setup or
    // finish at their real moments, and write-back dropped the 40 it never saw.
    const clip = adaptSwing(fixture);
    expect(clip.frames).toHaveLength(fixture.frames.length);
    expect(clip.frames).toHaveLength(49);
    // `i` is a contiguous render index over the full list, in source order.
    expect(clip.frames.map((f) => f.i)).toEqual(fixture.frames.map((_, i) => i));
    expect(clip.frames.map((f) => f.sourceMs)).toEqual(
      fixture.frames.map((f) => f.source_ms),
    );
    // The extremes of the +/-800 ms extraction are now reachable.
    expect(clip.frames[0].sourceMs).toBe(5501);
    expect(clip.frames[48].sourceMs).toBe(7101);
  });

  it('reports a verified, unreviewed swing as neither rejected nor triaged', () => {
    const clip = adaptSwing(fixture);
    expect(clip.rejected).toBe(false);
    expect(clip.triaged).toBe(false);
    expect(clip.grade).toBeNull();
    expect(clip.note).toBe('');
  });

  it('formats duration from the trim span', () => {
    // 8301 - 4801 = 3500 ms
    expect(adaptSwing(fixture).duration).toBe('0:03');
  });

  it('rejects a swing the detector failed or a human called a false positive', () => {
    const unverified: EtlSwingDoc = {
      ...fixture,
      detection: { ...fixture.detection, verified: false },
    };
    expect(adaptSwing(unverified).rejected).toBe(true);

    const dupe: EtlSwingDoc = {
      ...fixture,
      labels: { ...fixture.labels, verdict: 'duplicate' },
    };
    expect(adaptSwing(dupe).rejected).toBe(true);
  });

  describe('isRejected lets a human verdict disagree with detection.verified', () => {
    /**
     * `detection` is ETL-owned and the app cannot clear it, so ORing
     * `!verified` in unconditionally never converged: an unverified swing always
     * read as rejected, "restore" wrote `valid`, the next load re-rejected it,
     * and a subsequent "remove" wrote `valid` AGAIN — filing the reviewer's
     * rejection as an acceptance.
     */
    const doc = (verified: boolean, verdict: EtlSwingDoc['labels']['verdict']): EtlSwingDoc => ({
      ...fixture,
      detection: { ...fixture.detection, verified },
      labels: { ...fixture.labels, verdict },
    });

    it('matches the documented truth table exactly', () => {
      const table: [boolean, EtlSwingDoc['labels']['verdict'], boolean][] = [
        // verified, verdict, rejected
        [true, 'false_positive', true],
        [false, 'false_positive', true],
        [true, 'duplicate', true],
        [false, 'duplicate', true],
        [true, 'valid', false],
        // The row that makes the state machine converge: a human's accept call
        // overrides the detector.
        [false, 'valid', false],
        [true, 'unclear', false],
        [false, 'unclear', true],
        [true, null, false],
        // The ETL's own rejection, with no human call against it, must stand.
        [false, null, true],
      ];
      for (const [verified, verdict, rejected] of table) {
        expect(
          isRejected(doc(verified, verdict)),
          `verified=${String(verified)} verdict=${String(verdict)}`,
        ).toBe(rejected);
      }
    });

    it('still rejects an unverified swing no human has judged', () => {
      // The ETL's meaning is preserved: this is the case `verified: false` exists
      // to express, and it must not be softened by the fix above.
      expect(adaptSwing(doc(false, null)).rejected).toBe(true);
    });
  });

  it('treats an existing edit as triaged', () => {
    const edited: EtlSwingDoc = {
      ...fixture,
      edit: { by: 'wc', at: '2026-08-16T10:12:04Z', reviewed: true },
    };
    expect(adaptSwing(edited).triaged).toBe(true);
  });

  it('leaves conf unset, because the ETL has no classifier', () => {
    for (const f of adaptSwing(fixture).frames) {
      expect(f.conf).toBeUndefined();
    }
  });

  it('falls back to unassigned when both player_name and player_slot are null', () => {
    // player_slot can be null per EtlLabels.player_slot: EtlPlayerSlot | null
    const noPlayer: EtlSwingDoc = {
      ...fixture,
      labels: { ...fixture.labels, player_name: null, player_slot: null },
    };
    expect(adaptSwing(noPlayer).player).toBe('unassigned');
  });
});

describe('adaptSession isolates a swing it cannot read', () => {
  /**
   * The failure this covers: `adaptSwing` throws on a value the ETL's types
   * forbid but `overlay()` will happily merge in from a hand-edited
   * `user-edit.json`, and `loadEtlClips` used to catch that for the WHOLE
   * payload — returning the same `null` that means "there is no out/ tree". One
   * bad swing therefore dropped all 42 and the reviewer saw seed data with no
   * indication anything had failed.
   */
  const entry = (dir: string, doc: unknown): SwingEntry => ({
    dir,
    hash: 'sha256:abc',
    doc: doc as EtlSwingDoc,
    edit: null,
  });
  const readable = (dir: string, id: string) => entry(dir, { ...fixture, id });
  /** A non-string stroke: `strokeToApp` calls `.charAt`, so `adaptSwing` throws. */
  const malformed = (dir: string) =>
    entry(dir, { ...fixture, labels: { ...fixture.labels, stroke: 7 } });

  const payloadOf = (swings: SwingEntry[]): SessionPayload => ({
    session: 'IMG_0304',
    sessions: ['IMG_0304'],
    source: null,
    swings,
  });

  it('keeps every readable swing and names the one it could not read', () => {
    const { clips, skipped } = adaptSession(
      payloadOf([
        readable('swings/swing_001', 'IMG_0304/swing_001'),
        malformed('swings/swing_002'),
        readable('swings/swing_003', 'IMG_0304/swing_003'),
      ]),
    );
    expect(clips.map((c) => c.id)).toEqual(['IMG_0304/swing_001', 'IMG_0304/swing_003']);
    expect(skipped.map((s) => s.dir)).toEqual(['swings/swing_002']);
    // The adapter's own message, so a dev can tell which field was wrong.
    expect(skipped[0].reason).not.toBe('');
  });

  it('drops a skipped swing from entries, so write-back can never target it', () => {
    // `entries` is the write-back loop's work list. Leaving a swing there whose
    // doc the app could not read would invite a PUT built from no clip at all.
    const { entries } = adaptSession(
      payloadOf([malformed('swings/swing_001'), readable('swings/swing_002', 'ok')]),
    );
    expect(entries.map((e) => e.dir)).toEqual(['swings/swing_002']);
  });

  it('reports an all-malformed session as zero clips rather than as no tree', () => {
    // The distinction the bug erased: "nothing loaded because the tree is
    // absent" is normal and silent; "nothing loaded because every document was
    // unreadable" is a failure a human has to be told about.
    const { clips, skipped } = adaptSession(
      payloadOf([malformed('swings/swing_001'), malformed('swings/swing_002')]),
    );
    expect(clips).toEqual([]);
    expect(skipped.map((s) => s.dir)).toEqual(['swings/swing_001', 'swings/swing_002']);
  });

  it('still points a surviving clip’s frames at its own media directory', () => {
    // Skipping must not shift the media base: the URL is built per entry, not
    // from an index into the original list.
    const { clips } = adaptSession(
      payloadOf([malformed('swings/swing_001'), readable('swings/swing_002', 'ok')]),
    );
    expect(clips[0].frames[0].imageUrl).toBe(
      `/api/media/IMG_0304/swings/swing_002/${fixture.frames[0].file}`,
    );
  });

  it('reports no skips for a wholly readable session', () => {
    const { clips, skipped } = adaptSession(payloadOf([readable('swings/swing_001', 'ok')]));
    expect(clips).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('survives an entry that is not an object at all', () => {
    // `/api/session` is JSON off disk, so `swings` can contain anything. Reading
    // `dir` for the report must not throw a second time inside the catch.
    const { clips, skipped } = adaptSession(
      payloadOf([null as unknown as SwingEntry, readable('swings/swing_002', 'ok')]),
    );
    expect(clips.map((c) => c.id)).toEqual(['ok']);
    expect(skipped).toHaveLength(1);
  });
});

describe('the clip video', () => {
  const swing = () => structuredClone(realSwing) as unknown as EtlSwingDoc;

  it('points at the rendered clip the ETL named in trim.file', () => {
    const clip = adaptSwing(swing(), '/api/media/IMG_0305/swings/swing_001');
    expect(clip.videoUrl).toBe('/api/media/IMG_0305/swings/swing_001/clip.mp4');
  });

  it('follows trim.file rather than assuming the name', () => {
    const doc = swing();
    doc.trim.file = 'clip.webm';
    expect(adaptSwing(doc, '/base').videoUrl).toBe('/base/clip.webm');
  });

  it('is absent when there is no media behind the clip', () => {
    // Seeded clips reach `adaptSwing` with no base, and a `<video>` pointed at
    // a URL that 404s renders as a broken black box.
    expect(adaptSwing(swing()).videoUrl).toBeUndefined();
  });
});

describe('the source range shown on the row', () => {
  const swing = () => structuredClone(realSwing) as unknown as EtlSwingDoc;

  it('reports where the clip was cut from, not how long it runs', () => {
    // Every clip runs the same 3.5s by construction, so the duration alone is a
    // column of identical text. This is the part that differs per row.
    const doc = swing();
    doc.trim.source_start_ms = 58250;
    doc.trim.source_end_ms = 61750;
    // The clock floors, so the range alone reads as three seconds; the length
    // in parentheses is what says it is three and a half.
    expect(sourceRange(adaptSwing(doc))).toBe('0:58–1:01 (3.5s)');
  });

  it('carries the raw milliseconds through for anything that needs them', () => {
    const doc = swing();
    const clip = adaptSwing(doc);
    expect(clip.sourceStartMs).toBe(doc.trim.source_start_ms);
    expect(clip.sourceEndMs).toBe(doc.trim.source_end_ms);
  });

  it('falls back to the duration for a clip that came from no video', () => {
    const seeded = { ...adaptSwing(swing()), sourceStartMs: undefined, sourceEndMs: undefined };
    expect(sourceRange(seeded)).toBe(seeded.duration);
  });
});

describe('the catalog card’s timestamp and length', () => {
  const swing = () => structuredClone(realSwing) as unknown as EtlSwingDoc;

  it('shows where the clip starts in the session', () => {
    const doc = swing();
    doc.trim.source_start_ms = 40980;
    doc.trim.source_end_ms = 44480;
    expect(sourceStart(adaptSwing(doc))).toBe('0:40');
  });

  it('shows the length to a decimal, not as a floored clock', () => {
    // Every clip is the same 3.5s window; `0:03` both rounds it away and
    // would be indistinguishable from a 3.0s clip.
    const doc = swing();
    doc.trim.source_start_ms = 40980;
    doc.trim.source_end_ms = 44480;
    expect(clipLength(adaptSwing(doc))).toBe('3.5s');
    expect(adaptSwing(doc).duration).toBe('0:03');
  });

  it('drops a trailing zero, so a whole number reads as one', () => {
    const doc = swing();
    doc.trim.source_start_ms = 1000;
    doc.trim.source_end_ms = 4000;
    expect(clipLength(adaptSwing(doc))).toBe('3s');
  });

  it('falls back to the duration for a clip with no source timing', () => {
    const seeded = { ...adaptSwing(swing()), sourceStartMs: undefined, sourceEndMs: undefined };
    expect(sourceStart(seeded)).toBe(seeded.duration);
    expect(clipLength(seeded)).toBe(seeded.duration);
  });
});

describe('the card’s end timestamp', () => {
  const swing = () => structuredClone(realSwing) as unknown as EtlSwingDoc;

  it('reports where the clip ends in the source video', () => {
    const doc = swing();
    doc.trim.source_start_ms = 40980;
    doc.trim.source_end_ms = 44480;
    const clip = adaptSwing(doc);
    expect(sourceStart(clip)).toBe('0:40');
    expect(sourceEnd(clip)).toBe('0:44');
  });

  it('crosses the minute boundary the same way the start does', () => {
    const doc = swing();
    doc.trim.source_start_ms = 58500;
    doc.trim.source_end_ms = 62000;
    const clip = adaptSwing(doc);
    expect(sourceStart(clip)).toBe('0:58');
    expect(sourceEnd(clip)).toBe('1:02');
  });

  it('falls back to the duration when there is no source timing', () => {
    const seeded = { ...adaptSwing(swing()), sourceStartMs: undefined, sourceEndMs: undefined };
    expect(sourceEnd(seeded)).toBe(seeded.duration);
  });
});
