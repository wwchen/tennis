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

  it('keys frames on source_ms and writes only the sampled ones', () => {
    const clip = adaptSwing(source);
    clip.frames[4] = { ...clip.frames[4], phase: 'contact' };
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.frames).toHaveLength(9);
    expect(doc.frames.map((f) => f.source_ms)).toEqual([
      6168, 6201, 6234, 6268, 6301, 6334, 6368, 6401, 6434,
    ]);
    const contact = doc.frames.find((f) => f.source_ms === 6301);
    expect(contact?.stage).toBe('contact');
  });

  it('records a rejected clip as a verdict, not by editing detection', () => {
    const doc = toUserEdit({ ...adaptSwing(source), rejected: true }, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.verdict).toBe('false_positive');
    expect(doc.detection.verified).toBe(true);
  });
});
