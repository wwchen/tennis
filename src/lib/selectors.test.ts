import { describe, expect, it } from 'vitest';
import { buildCompare, rosterOf, statsOf, strokesOf, visibleClips } from './selectors';
import { SEED_NEXT_COMMENT_ID, seedClips, seedComments } from '@/domain/seed';
import type { Doc } from '@/state/persistence';
import type { Ui } from '@/state/store';
import { ALL_PLAYERS, ALL_RATINGS, ALL_STROKES } from '@/domain/types';

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
