import { describe, expect, it } from 'vitest';
import { buildCompare, rosterOf, statsOf, strokesOf, visibleClips } from './selectors';
import { SEED_NEXT_COMMENT_ID, seedClips, seedComments } from '@/domain/seed';
import type { Doc } from '@/state/persistence';
import type { Ui } from '@/state/store';
import { initialState, reducer } from '@/state/store';
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
  suspectOnly: false,
  inspectorPlaying: false,
  sourceMetaOpen: false,
  inlineClip: null,
  mobileFilters: false,
  sheetFull: false,
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
      const real = row.cells.filter((c) => c.real);
      expect(real.length).toBeLessThanOrEqual(FRAMES_PER_CLIP);
      expect(real.length).toBeGreaterThanOrEqual(FRAMES_PER_CLIP - 1);
      expect(row.cells).toHaveLength(colLabels.length);
    }
  });

  it('gives up a column rather than a uniform stride when the anchor sits off-grid', () => {
    // Anchor 25 of 49 at stride 6 can reach four strides back but only three
    // forward, so its row is eight columns of nine. The alternative — a stride
    // chosen per clip — would make column "+200ms" mean a different moment on
    // every row, which is the one thing the shared timeline cannot allow.
    const { rows } = buildCompare([long('B', 25)], 'contact', [], null);
    const real = rows[0].cells.filter((c) => c.real);
    expect(real).toHaveLength(FRAMES_PER_CLIP - 1);
    expect(real.map((c) => (c.real ? c.frame : -1))).toContain(25);
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
    // Anchored on 24 and strided by 6: the whole extraction, end to end.
    expect(frames).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
    // The label follows the real index, so f01 is genuinely the first still.
    const nums = rows[0].cells.filter((c) => c.real).map((c) => (c.real ? c.num : ''));
    expect(nums[0]).toBe('f01');
    expect(nums[8]).toBe('f49');
  });

  it('spends the columns one side cannot reach on the other, at either edge', () => {
    const atStart = buildCompare([long('A', 0)], 'contact', [], null).rows[0];
    const atEnd = buildCompare([long('B', 48)], 'contact', [], null).rows[0];
    const real = (r: typeof atStart) =>
      r.cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
    expect(real(atStart)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
    expect(real(atEnd)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
  });

  it('anchors an untagged clip with no ETL timing on the middle of its extraction', () => {
    // The last-resort fallback, reached by seeded clips: no phase tag AND no
    // `offsetContactMs`, so the midpoint is the only guess available.
    const untagged = long('U', -1);
    expect(untagged.frames[0].offsetContactMs).toBeUndefined();
    const { rows } = buildCompare([untagged], 'contact', [], null);
    const frames = rows[0].cells.filter((c) => c.real).map((c) => (c.real ? c.frame : -1));
    expect(frames).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
  });

  it('handles a short clip, and the 42- and 47-frame swings the real tree has', () => {
    for (const length of [3, 42, 47]) {
      const { rows, colLabels } = buildCompare([long('S', 24 % length, length)], 'contact', [], null);
      const real = rows[0].cells.filter((c) => c.real);
      // At most a full window; one short when the anchor sits off the stride
      // grid near an edge, which is the documented cost of a uniform stride.
      expect(real.length).toBeGreaterThanOrEqual(Math.min(FRAMES_PER_CLIP, length) - 1);
      expect(real.length).toBeLessThanOrEqual(Math.min(FRAMES_PER_CLIP, length));
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
  it('spends its nine columns on the whole clip, not on a third of a second', () => {
    // 49 stills 33 ms apart: adjacent frames 20-28 are ±133 ms around contact,
    // which is the racket passing through the ball and nine identical-looking
    // tiles. Striding by 6 covers the full ±800 ms the ETL extracted.
    expect(frameWindow(49, 24)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
  });

  it('keeps the anchor on the stride grid when it is not the midpoint', () => {
    expect(frameWindow(49, 25)).toEqual([1, 7, 13, 19, 25, 31, 37, 43]);
  });

  it('spends what one side cannot reach on the other', () => {
    // Contact at the very first frame can look forward only, so it does.
    expect(frameWindow(49, 0)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
    expect(frameWindow(49, 48)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48]);
  });

  it('returns the whole list when it is no wider than the window', () => {
    expect(frameWindow(9, 4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frameWindow(3, 0)).toEqual([0, 1, 2]);
    expect(frameWindow(3, 2)).toEqual([0, 1, 2]);
  });

  it('always contains its anchor, in ascending order, inside the list', () => {
    for (let n = 1; n <= 49; n++) {
      for (let a = 0; a < n; a++) {
        const window = frameWindow(n, a);
        const where = `n=${n} anchor=${a}`;
        expect(window, where).toContain(a);
        expect(window.length, where).toBeLessThanOrEqual(Math.min(FRAMES_PER_CLIP, n));
        expect(window[0], where).toBeGreaterThanOrEqual(0);
        expect(window[window.length - 1], where).toBeLessThan(n);
        expect([...window].sort((x, y) => x - y), where).toEqual(window);
        expect(new Set(window).size, where).toBe(window.length);
      }
    }
  });

  it('is empty for an empty list', () => {
    expect(frameWindow(0, 0)).toEqual([]);
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

describe('the "likely not a swing" filter', () => {
  const measured = (id: string, wristSpeed: number, armOffset: number): Clip => ({
    id,
    player: 'left',
    stroke: null,
    rejected: false,
    duration: '0:03',
    triaged: false,
    grade: null,
    note: '',
    frames: [{ i: 0, sourceMs: 0, phase: null }],
    measurements: { wristSpeed, armOffset },
  });

  const docOf = (clips: Clip[]): Doc => ({
    clips,
    comments: [],
    extraPlayers: [],
    removedStack: [],
    nextCommentId: 1,
  });

  it('keeps only the swings that are both slow and unextended', () => {
    // Measured shapes from the real tree: a standing body, a drop shot (slow
    // but the arm is out), a mishit (fast, arm in), a normal drive.
    const d = docOf([
      measured('standing', 2.27, 0.01),
      measured('drop-shot', 2.4, 0.9),
      measured('fast-arm-in', 22.0, 0.1),
      measured('drive', 28.0, 1.1),
    ]);
    const kept = visibleClips(d, ui({ suspectOnly: true })).map((c) => c.id);
    expect(kept).toEqual(['standing']);
  });

  it('is off by default, so nothing is hidden until asked', () => {
    const d = docOf([measured('standing', 2.27, 0.01), measured('drive', 28.0, 1.1)]);
    expect(visibleClips(d, ui()).map((c) => c.id)).toEqual(['standing', 'drive']);
  });

  it('never flags a clip with no measurements rather than guessing', () => {
    // Seeded clips carry none. Treating "unmeasured" as "suspect" would hide
    // the whole seed the moment the toggle went on.
    const unmeasured = { ...measured('seed', 0, 0) };
    delete unmeasured.measurements;
    const d = docOf([unmeasured]);
    expect(visibleClips(d, ui({ suspectOnly: true }))).toEqual([]);
  });

  it('reads the sign of the arm offset, not its direction', () => {
    // `contact_offset` is signed: a left-handed contact is negative and just as
    // extended, so flagging on the raw value would flag every left-side shot.
    const d = docOf([measured('left-side', 2.0, -0.9)]);
    expect(visibleClips(d, ui({ suspectOnly: true }))).toEqual([]);
  });
});

describe('the selected clip is findable', () => {
  // The highlight is styling, so what is pinned here is the fact it keys off:
  // playing a clip must leave `sel` naming that clip, or the row the reviewer
  // is being shown in the inspector cannot be marked at all.
  it('playing a clip leaves the selection on it', () => {
    const clip: Clip = {
      id: 'IMG_0305/swing_042',
      player: 'left',
      stroke: null,
      rejected: false,
      duration: '0:03',
      triaged: false,
      grade: null,
      note: '',
      frames: [
        { i: 0, sourceMs: 0, phase: null },
        { i: 1, sourceMs: 500, phase: 'contact' },
      ],
    };
    const base = initialState();
    const state = { ...base, doc: { ...base.doc, clips: [clip] } };
    const played = reducer(state, { type: 'playClip', clip: clip.id });
    expect(played.ui.sel?.clip).toBe(clip.id);
  });
});
