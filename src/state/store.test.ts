import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, State } from './store';
import { initialState, reducer, useShotLab } from './store';
import { loadDoc, saveDoc } from './persistence';
import { ADD_PLAYER } from '@/domain/types';
import type { SwingEntry } from '@/domain/etl-types';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import * as etlSource from './etl-source';

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

  it('marks a clip triaged when the only edit is a note', () => {
    // Write-back is gated on `triaged`, so a note-only edit that left it false
    // was a silent no-op: saved to localStorage, never sent to user-edit.json.
    let s = initialState();
    expect(clip(s, 'SL-001').triaged).toBe(false);
    s = run(s, { type: 'setNote', clip: 'SL-001', note: 'duplicate of 14' });
    expect(clip(s, 'SL-001').note).toBe('duplicate of 14');
    expect(clip(s, 'SL-001').triaged).toBe(true);
  });

  it('marks a clip triaged when the only edit is a rejection', () => {
    let s = initialState();
    expect(clip(s, 'SL-001').triaged).toBe(false);
    s = run(s, { type: 'toggleReject', clip: 'SL-001' });
    expect(clip(s, 'SL-001').rejected).toBe(true);
    expect(clip(s, 'SL-001').triaged).toBe(true);
    // Un-rejecting is still a call a human made, so it stays reviewed.
    s = run(s, { type: 'toggleReject', clip: 'SL-001' });
    expect(clip(s, 'SL-001').rejected).toBe(false);
    expect(clip(s, 'SL-001').triaged).toBe(true);
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

describe('write-back deduplication', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    // Prevent the initial ETL load from interfering
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends each triaged clip once, not on every effect run', async () => {
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never },
      { dir: 'swings/swing_002', hash: 'sha256:def', doc: realSwing as never },
    ];

    const { result, rerender } = renderHook(() => useShotLab());

    // Hydrate with two triaged clips
    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [
          { ...result.current.state.doc.clips[0], id: 'IMG_0304/swing_001', triaged: true, grade: 'good' },
          { ...result.current.state.doc.clips[1], id: 'IMG_0304/swing_002', triaged: true, grade: 'ok' },
        ],
        entries,
        session: 'IMG_0304',
      });
    });

    // Wait for debounced write
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });

    // Re-run the effect for real: `patchClip` rebuilds the clips array, so this
    // changes the dep's identity while leaving the payload byte-identical.
    // A bare `rerender()` would not re-run the effect at all.
    const sameNote = clip(result.current.state, 'IMG_0304/swing_001').note;
    act(() => {
      result.current.dispatch({ type: 'setNote', clip: 'IMG_0304/swing_001', note: sameNote });
    });
    rerender();

    // Wait to ensure no new PUTs
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Still only 2 calls — dedup prevented redundant writes
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends again when clip content actually changes', async () => {
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never },
    ];

    const { result } = renderHook(() => useShotLab());

    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [{ ...result.current.state.doc.clips[0], id: 'IMG_0304/swing_001', triaged: true, grade: 'good' }],
        entries,
        session: 'IMG_0304',
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    // Change the note
    act(() => {
      result.current.dispatch({ type: 'setNote', clip: 'IMG_0304/swing_001', note: 'late contact' });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it('retries after a rejected write instead of caching it as sent', async () => {
    // `fetch` resolves for 4xx/5xx, so caching without checking `res.ok` retired
    // the label permanently on a 404 or a 400.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never },
    ];

    const { result, rerender } = renderHook(() => useShotLab());

    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [
          { ...result.current.state.doc.clips[0], id: 'IMG_0304/swing_001', triaged: true, grade: 'good' },
        ],
        entries,
        session: 'IMG_0304',
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    // Re-run the effect with the payload unchanged. The dedup cache is the only
    // thing that could suppress the second PUT, and a 404 must not have filled
    // it — the reviewer's label is still not on disk.
    const sameNote = clip(result.current.state, 'IMG_0304/swing_001').note;
    act(() => {
      result.current.dispatch({ type: 'setNote', clip: 'IMG_0304/swing_001', note: sameNote });
    });
    rerender();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});
