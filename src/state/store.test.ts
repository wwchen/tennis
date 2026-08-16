import { beforeEach, describe, expect, it } from 'vitest';
import type { Action, State } from './store';
import { initialState, reducer } from './store';
import { loadDoc, saveDoc } from './persistence';
import { ADD_PLAYER } from '@/domain/types';

/** Applies a sequence of actions so a test reads as the user's clicks. */
const run = (state: State, ...actions: Action[]): State => actions.reduce(reducer, state);

const clip = (s: State, id: string) => {
  const found = s.doc.clips.find((c) => c.id === id);
  if (!found) throw new Error(`no clip ${id}`);
  return found;
};

describe('reducer', () => {
  beforeEach(() => localStorage.clear());

  it('rates a clip, then clears it when the same chip is picked again', () => {
    let s = initialState();
    s = run(s, { type: 'setGrade', clip: 'SL-001', grade: 'good' });
    expect(clip(s, 'SL-001').grade).toBe('good');
    expect(clip(s, 'SL-001').triaged).toBe(true);

    s = run(s, { type: 'setGrade', clip: 'SL-001', grade: 'good' });
    expect(clip(s, 'SL-001').grade).toBeNull();

    s = run(s, { type: 'setGrade', clip: 'SL-001', grade: 'work' });
    expect(clip(s, 'SL-001').grade).toBe('work');
  });

  it('removes and restores a clip through the undo stack', () => {
    let s = initialState();
    expect(s.doc.removedStack).toEqual(['SL-011']);

    s = run(s, { type: 'toggleReject', clip: 'SL-004' });
    expect(clip(s, 'SL-004').rejected).toBe(true);
    expect(s.doc.removedStack).toEqual(['SL-011', 'SL-004']);

    // Undo takes the most recent removal, not the seeded one.
    s = run(s, { type: 'undoRemove' });
    expect(clip(s, 'SL-004').rejected).toBe(false);
    expect(s.doc.removedStack).toEqual(['SL-011']);

    s = run(s, { type: 'undoRemove' });
    expect(clip(s, 'SL-011').rejected).toBe(false);
    expect(s.doc.removedStack).toEqual([]);
    // Nothing left to undo — must not throw or corrupt the doc.
    expect(run(s, { type: 'undoRemove' }).doc.clips).toHaveLength(12);
  });

  it('moves a phase tag off whichever frame held it before', () => {
    let s = initialState();
    // SL-001 is seeded with contact at frame 4.
    expect(clip(s, 'SL-001').frames[4].phase).toBe('contact');

    s = run(s, { type: 'setPhase', clip: 'SL-001', frame: 6, phase: 'contact' });
    expect(clip(s, 'SL-001').frames[6].phase).toBe('contact');
    expect(clip(s, 'SL-001').frames[4].phase).toBeNull();
    // A hand-made call is certain by definition.
    expect(clip(s, 'SL-001').frames[6].conf).toBe(1);
    expect(clip(s, 'SL-001').triaged).toBe(true);
  });

  it('clearing a phase leaves the other tags alone', () => {
    let s = initialState();
    s = run(s, { type: 'setPhase', clip: 'SL-001', frame: 4, phase: null });
    expect(clip(s, 'SL-001').frames[4].phase).toBeNull();
    expect(clip(s, 'SL-001').frames[1].phase).toBe('setup');
    expect(clip(s, 'SL-001').frames[7].phase).toBe('finish');
  });

  it('routes the "+ Add player" sentinel to the new-player bar', () => {
    let s = initialState();
    s = run(s, { type: 'setClipPlayer', clip: 'SL-001', player: ADD_PLAYER });
    expect(s.ui.addingPlayer).toBe(true);
    expect(s.ui.editingPlayer).toBe('SL-001');
    // The sentinel must never land on the clip as a name.
    expect(clip(s, 'SL-001').player).toBe('Me');

    s = run(s, { type: 'setNewPlayer', value: '  Sam  ' }, { type: 'commitNewPlayer' });
    expect(clip(s, 'SL-001').player).toBe('Sam');
    expect(s.doc.extraPlayers).toEqual(['Sam']);
    expect(s.ui.addingPlayer).toBe(false);
  });

  it('ignores a blank new-player name', () => {
    let s = initialState();
    s = run(
      s,
      { type: 'setClipPlayer', clip: 'SL-001', player: ADD_PLAYER },
      { type: 'setNewPlayer', value: '   ' },
      { type: 'commitNewPlayer' },
    );
    expect(s.doc.extraPlayers).toEqual([]);
    expect(clip(s, 'SL-001').player).toBe('Me');
  });

  it('pins a comment to the selected frame and clears the draft', () => {
    let s = initialState();
    s = run(
      s,
      { type: 'select', clip: 'SL-009', frame: 2 },
      { type: 'setDraft', value: '  toss is late  ' },
      { type: 'postComment' },
    );

    const posted = s.doc.comments.at(-1);
    expect(posted).toMatchObject({ clip: 'SL-009', frame: 2, author: 'Me', text: 'toss is late' });
    expect(s.ui.draft).toBe('');
    expect(s.doc.nextCommentId).toBe(6);
  });

  it('refuses to post a blank comment', () => {
    let s = initialState();
    const before = s.doc.comments.length;
    s = run(s, { type: 'setDraft', value: '   ' }, { type: 'postComment' });
    expect(s.doc.comments).toHaveLength(before);
  });

  it('drops a half-typed draft when the selection moves', () => {
    let s = initialState();
    s = run(
      s,
      { type: 'setDraft', value: 'half typed' },
      { type: 'select', clip: 'SL-001', frame: 3 },
    );
    expect(s.ui.draft).toBe('');
  });
});

describe('persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a doc and reloads the edits, not the seed', () => {
    const edited = reducer(initialState(), { type: 'setGrade', clip: 'SL-001', grade: 'good' });
    saveDoc(edited.doc);

    const restored = initialState();
    expect(clip(restored, 'SL-001').grade).toBe('good');
  });

  it('falls back to a fresh seed when storage holds junk', () => {
    localStorage.setItem('shot-lab.doc', '{not json');
    expect(loadDoc()).toBeNull();
    expect(initialState().doc.clips).toHaveLength(12);
  });

  it('discards a doc written by an incompatible version', () => {
    localStorage.setItem('shot-lab.doc', JSON.stringify({ v: 999, clips: [] }));
    expect(loadDoc()).toBeNull();
  });
});
