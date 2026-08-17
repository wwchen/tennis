import { describe, expect, it } from 'vitest';
import { buildCompare, rosterOf, statsOf, strokesOf, visibleClips } from './selectors';
import { SEED_NEXT_COMMENT_ID, seedClips, seedComments } from '@/domain/seed';
import type { Doc } from '@/state/persistence';
import type { Ui } from '@/state/store';
import type { Clip } from '@/domain/types';
import { ALL_PLAYERS, ALL_RATINGS, ALL_STROKES, FRAMES_PER_CLIP } from '@/domain/types';
import { frameWindow } from '@/domain/window';
import type { EtlSwingDoc } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
import realSwing from '@/domain/__fixtures__/swing-real.json';

const doc = (): Doc => ({
  clips: seedClips(),
  comments: seedComments(),
  extraPlayers: [],
  removedStack: ['SL-011'],
  nextCommentId: SEED_NEXT_COMMENT_ID,
});

const ui = (patch: Partial<Ui> = {}): Ui => ({
  view: 'compare',
  playerFilter: ALL_PLAYERS,
  strokeFilter: ALL_STROKES,
  gradeFilter: ALL_RATINGS,
  anchor: 'contact',
  onlyAnchor: false,
  lowOnly: false,
  showRejected: false,
  filtersOpen: true,
  sel: null,
  detail: null,
  draft: '',
  playing: false,
  editingStroke: null,
  editingPlayer: null,
  addingPlayer: false,
  newPlayer: '',
  ...patch,
});

describe('visibleClips', () => {
  it('hides removed clips until "show removed" is on', () => {
    const d = doc();
    expect(visibleClips(d, ui()).map((c) => c.id)).not.toContain('SL-011');
    expect(visibleClips(d, ui({ showRejected: true })).map((c) => c.id)).toContain('SL-011');
  });

  it('filters by player, stroke and rating together', () => {
    const d = doc();
    const byPlayer = visibleClips(d, ui({ playerFilter: 'Coach Ana' }));
    expect(byPlayer.map((c) => c.id)).toEqual(['SL-007', 'SL-016']);

    const both = visibleClips(d, ui({ playerFilter: 'Coach Ana', strokeFilter: 'Serve' }));
    expect(both.map((c) => c.id)).toEqual(['SL-016']);

    // Nothing is rated in the seed, so every clip reads as "Unrated".
    expect(visibleClips(d, ui({ gradeFilter: 'Good' }))).toHaveLength(0);
    expect(visibleClips(d, ui({ gradeFilter: 'Unrated' }))).toHaveLength(11);
  });

  it('"unchecked auto-tags only" drops clips a human has already touched', () => {
    const ids = visibleClips(doc(), ui({ lowOnly: true })).map((c) => c.id);
    // SL-002 and SL-012 are seeded as triaged; SL-011 is removed.
    expect(ids).not.toContain('SL-002');
    expect(ids).not.toContain('SL-012');
    expect(ids).toContain('SL-001');
  });
});

describe('buildCompare', () => {
  it('puts every clip’s anchor frame in the same column', () => {
    const d = doc();
    const clips = visibleClips(d, ui());
    const { rows, colLabels } = buildCompare(clips, 'contact', d.comments, null);
    const anchorCol = colLabels.indexOf('CONTACT');

    expect(anchorCol).toBeGreaterThanOrEqual(0);
    for (const row of rows) {
      const cell = row.cells[anchorCol];
      expect(cell.real, `${row.clip.id} has no cell under CONTACT`).toBe(true);
      if (cell.real) {
        const frame = row.clip.frames[cell.frame];
        expect(frame.phase, `${row.clip.id} column ${anchorCol}`).toBe('contact');
      }
    }
  });

  it('labels columns by their offset from the anchor', () => {
    const d = doc();
    const { colLabels } = buildCompare(visibleClips(d, ui()), 'setup', d.comments, null);
    const at = colLabels.indexOf('SETUP');
    expect(colLabels[at - 1]).toBe('-1');
    expect(colLabels[at + 1]).toBe('+1');
  });

  it('gives every row the same number of cells', () => {
    const d = doc();
    const { rows, colLabels } = buildCompare(visibleClips(d, ui()), 'finish', d.comments, null);
    for (const row of rows) expect(row.cells).toHaveLength(colLabels.length);
  });

  it('marks the selected cell and counts pinned comments', () => {
    const d = doc();
    const { rows } = buildCompare(visibleClips(d, ui()), 'contact', d.comments, {
      clip: 'SL-002',
      frame: 5,
    });
    const row = rows.find((r) => r.clip.id === 'SL-002');
    const cell = row?.cells.find((c) => c.real && c.frame === 5);
    expect(cell?.real && cell.selected).toBe(true);
    // Two seeded comments sit on SL-002 frame 5.
    expect(cell?.real && cell.pinCount).toBe(2);
  });

  it('survives an empty clip list', () => {
    const { rows, colLabels } = buildCompare([], 'contact', [], null);
    expect(rows).toEqual([]);
    expect(colLabels.length).toBeGreaterThan(0);
  });
});

describe('buildCompare narrows real 49-frame clips', () => {
  /** A `Clip` shaped like ETL output: every extracted frame, one anchor tag. */
  const long = (id: string, anchorAt: number, length = 49): Clip => ({
    id,
    player: 'left',
    stroke: null,
    rejected: false,
    duration: '0:03',
    triaged: false,
    grade: null,
    note: '',
    frames: Array.from({ length }, (_, i) => ({
      i,
      sourceMs: 5501 + i * 33,
      phase: i === anchorAt ? ('contact' as const) : null,
    })),
  });

  it('shows at most FRAMES_PER_CLIP cells per row, not all 49', () => {
    // Without the window, 12 clips of 49 stills is a 588-tile grid — and the
    // seed's 9-frame rows would be padded out to 49 columns wide.
    const { rows, colLabels } = buildCompare([long('A', 24), long('B', 20)], 'contact', [], null);
    for (const row of rows) {
      expect(row.cells.filter((c) => c.real)).toHaveLength(FRAMES_PER_CLIP);
      expect(row.cells).toHaveLength(colLabels.length);
    }
  });

  it('aligns every anchor in the same column across clips with different anchors', () => {
    const clips = [long('A', 24), long('B', 4), long('C', 46), long('D', 12)];
    const { rows, colLabels } = buildCompare(clips, 'contact', [], null);
    const anchorCol = colLabels.indexOf('CONTACT');
    expect(anchorCol).toBeGreaterThanOrEqual(0);

    for (const row of rows) {
      const cell = row.cells[anchorCol];
      expect(cell.real, `${row.clip.id} has no cell under CONTACT`).toBe(true);
      if (cell.real) {
        // `cell.frame` indexes the FULL frame list, so the anchor's real index
        // comes back — not a position within the window.
        expect(row.clip.frames[cell.frame].phase).toBe('contact');
      }
    }
  });

  it('keeps cell.frame a valid index into the full list, offset by the window', () => {
    const { rows } = buildCompare([long('A', 24)], 'contact', [], null);
    const frames = rows[0].cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
    // Centred on 24: a 9-wide window is [20, 28].
    expect(frames).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
    // The label follows the real index, so f21 is genuinely the 21st still.
    const nums = rows[0].cells.filter((c) => c.real).map((c) => (c.real ? c.num : ''));
    expect(nums[0]).toBe('f21');
    expect(nums[8]).toBe('f29');
  });

  it('shifts the window inward rather than shortening it at either edge', () => {
    const atStart = buildCompare([long('A', 1)], 'contact', [], null).rows[0];
    const atEnd = buildCompare([long('B', 47)], 'contact', [], null).rows[0];
    const real = (r: typeof atStart) => r.cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
    expect(real(atStart)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(real(atEnd)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48]);
  });

  it('anchors an untagged clip with no ETL timing on the middle of its extraction', () => {
    // The last-resort fallback, reached by seeded clips: no phase tag AND no
    // `offsetContactMs`, so the midpoint is the only guess available.
    const untagged = long('U', -1);
    expect(untagged.frames[0].offsetContactMs).toBeUndefined();
    const { rows } = buildCompare([untagged], 'contact', [], null);
    const frames = rows[0].cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
    expect(frames).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
  });

  it('handles a short clip, and the 42- and 47-frame swings the real tree has', () => {
    for (const length of [3, 42, 47]) {
      const { rows, colLabels } = buildCompare([long('S', 24 % length, length)], 'contact', [], null);
      const real = rows[0].cells.filter((c) => c.real);
      expect(real).toHaveLength(Math.min(FRAMES_PER_CLIP, length));
      expect(rows[0].cells).toHaveLength(colLabels.length);
      for (const cell of real) {
        if (cell.real) expect(rows[0].clip.frames[cell.frame]).toBeDefined();
      }
    }
  });

  it('renders the 9-frame seed exactly as it did before the window existed', () => {
    // The seed is one full window wide, so windowing is the identity on it —
    // which is what lets the pre-existing buildCompare tests still pass.
    const d = doc();
    const { rows } = buildCompare(visibleClips(d, ui()), 'contact', d.comments, null);
    for (const row of rows) {
      const frames = row.cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
      expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });
});

describe('the CONTACT column on real ETL data', () => {
  /**
   * Every real ETL frame ships with `stage: null`, so all 42 swings of the
   * sample tree take the untagged path. The midpoint is NOT contact there:
   * `render.py` truncates extraction at the video boundaries, so a swing near
   * either end of the source is not centred on its contact frame — measured off
   * by 1 on swing_041 and by 4 frames (~133 ms) on swing_042, with nothing on
   * screen to say so. `offset_contact_ms === 0` is the ETL's own answer and is
   * already in the data.
   */
  const contactIndexOf = (clip: Clip): number => {
    const f = clip.frames.find((fr) => fr.offsetContactMs === 0);
    if (f === undefined) throw new Error('fixture has no contact frame');
    return f.i;
  };

  /** The column `buildCompare` actually puts this clip's CONTACT cell in. */
  const anchoredFrame = (clip: Clip): number => {
    const { rows, colLabels } = buildCompare([clip], 'contact', [], null);
    const cell = rows[0].cells[colLabels.indexOf('CONTACT')];
    if (!cell.real) throw new Error('CONTACT column is a padding cell');
    return cell.frame;
  };

  it('lands on the true contact frame of the real 49-frame fixture', () => {
    const clip = adaptSwing(realSwing as unknown as EtlSwingDoc);
    expect(clip.frames.every((f) => f.phase === null)).toBe(true);
    expect(anchoredFrame(clip)).toBe(contactIndexOf(clip));
  });

  /**
   * A truncated extraction, shaped like swing_042: 42 frames whose contact sits
   * at index 24, not at the midpoint of 20. Built from the real fixture's own
   * timing so the offsets stay self-consistent.
   */
  const truncated = (length: number, contactAt: number): Clip => {
    const full = realSwing as unknown as EtlSwingDoc;
    const step = 33;
    return adaptSwing({
      ...full,
      frames: Array.from({ length }, (_, i) => ({
        ...full.frames[0],
        file: `frames/frame_${String(i).padStart(4, '0')}.jpg`,
        source_ms: 5501 + i * step,
        clip_ms: i * step,
        // Signed from contact, exactly 0 on the contact frame.
        offset_contact_ms: (i - contactAt) * step,
        stage: null,
      })),
    });
  };

  it('lands on true contact for a truncated extraction, not the midpoint', () => {
    // swing_042's real shape. The midpoint would be 20 — off by 4 frames.
    const clip = truncated(42, 24);
    expect(Math.floor((clip.frames.length - 1) / 2)).toBe(20);
    expect(contactIndexOf(clip)).toBe(24);
    expect(anchoredFrame(clip)).toBe(24);
  });

  it('lands on true contact for swing_041’s shape too', () => {
    // 47 frames, contact at 24, midpoint 23 — off by 1.
    const clip = truncated(47, 24);
    expect(Math.floor((clip.frames.length - 1) / 2)).toBe(23);
    expect(anchoredFrame(clip)).toBe(24);
  });

  it('aligns truncated and untruncated swings in the SAME column', () => {
    // The point of the grid: two swings of different lengths are comparable
    // only if their contact frames share a column.
    const clips = [truncated(49, 24), truncated(42, 24), truncated(47, 24)];
    const { rows, colLabels } = buildCompare(clips, 'contact', [], null);
    const anchorCol = colLabels.indexOf('CONTACT');
    for (const row of rows) {
      const cell = row.cells[anchorCol];
      expect(cell.real, `${row.clip.id} has no cell under CONTACT`).toBe(true);
      if (cell.real) {
        expect(row.clip.frames[cell.frame].offsetContactMs).toBe(0);
      }
    }
  });

  it('still prefers a human’s tag over the detector’s contact frame', () => {
    // A reviewer who tags contact somewhere else is correcting the detector, and
    // the correction has to win.
    const clip = truncated(42, 24);
    const retagged: Clip = {
      ...clip,
      frames: clip.frames.map((f) => (f.i === 10 ? { ...f, phase: 'contact' as const } : f)),
    };
    expect(anchoredFrame(retagged)).toBe(10);
  });

  it('falls back to the midpoint for setup and finish, which have no ETL equivalent', () => {
    // The ETL detects contact only, so an untagged clip has nothing better to
    // offer for the other two anchors.
    const clip = truncated(42, 24);
    for (const anchor of ['setup', 'finish'] as const) {
      const { rows, colLabels } = buildCompare([clip], anchor, [], null);
      const cell = rows[0].cells[colLabels.indexOf(anchor.toUpperCase())];
      expect(cell.real).toBe(true);
      if (cell.real) expect(cell.frame).toBe(20);
    }
  });
});

describe('frameWindow', () => {
  it('centres a 9-wide window on the anchor', () => {
    expect(frameWindow(49, 24)).toEqual({ start: 20, end: 29 });
    expect(frameWindow(49, 25)).toEqual({ start: 21, end: 30 });
  });

  it('clamps to the list rather than returning a short window', () => {
    expect(frameWindow(49, 0)).toEqual({ start: 0, end: 9 });
    expect(frameWindow(49, 48)).toEqual({ start: 40, end: 49 });
  });

  it('returns the whole list when it is no wider than the window', () => {
    expect(frameWindow(9, 4)).toEqual({ start: 0, end: 9 });
    expect(frameWindow(3, 0)).toEqual({ start: 0, end: 3 });
    expect(frameWindow(3, 2)).toEqual({ start: 0, end: 3 });
  });

  it('always contains its anchor', () => {
    for (let n = 1; n <= 49; n++) {
      for (let a = 0; a < n; a++) {
        const { start, end } = frameWindow(n, a);
        expect(a, `n=${n} anchor=${a}`).toBeGreaterThanOrEqual(start);
        expect(a, `n=${n} anchor=${a}`).toBeLessThan(end);
        expect(end - start).toBe(Math.min(FRAMES_PER_CLIP, n));
      }
    }
  });

  it('is empty for an empty list', () => {
    expect(frameWindow(0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('stats and roster', () => {
  it('counts unrated clips excluding removed ones', () => {
    const d = doc();
    const s = statsOf(d, visibleClips(d, ui()));
    expect(s.total).toBe(12);
    expect(s.visible).toBe(11);
    expect(s.removed).toBe(1);
    expect(s.rated).toBe(0);
    expect(s.unrated).toBe(11);
    expect(s.frames).toBe(11 * 9);
  });

  it('lists each player once, including hand-added ones', () => {
    expect(rosterOf({ ...doc(), extraPlayers: ['Sam'] })).toEqual([
      'Me',
      'Coach Ana',
      'Pro reference',
      'Sam',
    ]);
  });
});

describe('null strokes', () => {
  it('an untagged clip survives the "all strokes" filter but no specific one', () => {
    const d = doc();
    d.clips = [{ ...d.clips[0], id: 'X-1', stroke: null }];
    expect(visibleClips(d, ui()).map((c) => c.id)).toEqual(['X-1']);
    expect(visibleClips(d, ui({ strokeFilter: 'Forehand' }))).toHaveLength(0);
  });

  it('strokesOf never offers null as a filter option', () => {
    const d = doc();
    d.clips = [{ ...d.clips[0], stroke: null }, { ...d.clips[1], stroke: 'Backhand' }];
    expect(strokesOf(d)).toEqual(['Backhand']);
  });
});
