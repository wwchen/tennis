import { describe, expect, it } from 'vitest';
import realSwing from './__fixtures__/swing-real.json';
import type { EtlSwingDoc } from './etl-types';
import { adaptSwing, qualityToGrade, sampleFrames, stageToPhase, strokeToApp } from './etl';
import { FRAMES_PER_CLIP } from './types';

const fixture = realSwing as unknown as EtlSwingDoc;

describe('sampleFrames', () => {
  it('takes a 9-frame window centred on contact from a real 49-frame swing', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    expect(picked).toHaveLength(FRAMES_PER_CLIP);
    // Verified against the real fixture: contact_ms 6301, 33 ms frame step.
    expect(picked.map((f) => f.offset_contact_ms)).toEqual([
      -133, -100, -67, -33, 0, 33, 67, 100, 133,
    ]);
    expect(picked.map((f) => f.source_ms)).toEqual([
      6168, 6201, 6234, 6268, 6301, 6334, 6368, 6401, 6434,
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
