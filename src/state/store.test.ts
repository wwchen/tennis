import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, State } from './store';
import { initialState, reducer, useShotLab } from './store';
import { loadDoc, saveDoc } from './persistence';
import { ADD_PLAYER, shortId } from '@/domain/types';
import type { Clip, Phase } from '@/domain/types';
import type { EtlSwingDoc, SwingEntry } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
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

  describe('openDetail and the selection', () => {
    it('drops a selection belonging to a different clip', () => {
      // A selection is (clip, frame). Carrying it across clips ghost-highlighted
      // a frame nobody clicked, and `App.tsx` indexes
      // `selClip.frames[ui.sel.frame]` — a stale index from a 49-frame clip is
      // undefined on a shorter one. Unreachable at 9 frames each, live at 42-49.
      let s = initialState();
      s = run(s, { type: 'select', clip: 'SL-002', frame: 8 });
      expect(s.ui.sel).toEqual({ clip: 'SL-002', frame: 8 });

      s = run(s, { type: 'openDetail', clip: 'SL-004' });
      expect(s.ui.detail).toBe('SL-004');
      expect(s.ui.sel).toBeNull();
    });

    it('keeps a selection already on the clip being opened', () => {
      // Clicking a frame and then opening its own clip should land on that
      // frame, so the reset has to be conditional rather than unconditional.
      let s = initialState();
      s = run(
        s,
        { type: 'select', clip: 'SL-004', frame: 3 },
        { type: 'openDetail', clip: 'SL-004' },
      );
      expect(s.ui.sel).toEqual({ clip: 'SL-004', frame: 3 });
    });

    it('leaves a null selection null', () => {
      const s = run(initialState(), { type: 'clearSelection' }, { type: 'openDetail', clip: 'SL-001' });
      expect(s.ui.sel).toBeNull();
      expect(s.ui.view).toBe('detail');
    });
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
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never, edit: null },
      { dir: 'swings/swing_002', hash: 'sha256:def', doc: realSwing as never, edit: null },
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
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never, edit: null },
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

  it('writes back a previously-reviewed swing unchanged on a bare page load', async () => {
    // The §1 symptom, at the layer it actually happened: hydrating a tree that
    // already has user-edit.json files derives `triaged: true`, so the effect
    // PUTs every one of them with no human action. That is only safe if the
    // payload matches what is already on disk.
    const onDisk = {
      ...(realSwing as unknown as EtlSwingDoc),
      labels: {
        ...(realSwing as unknown as EtlSwingDoc).labels,
        quality: 5 as const,
        verdict: 'duplicate' as const,
        player_name: null,
        stroke: 'backhand' as const,
        notes: 'shanked, keep for the reel',
      },
      frames: (realSwing as unknown as EtlSwingDoc).frames.map((f, i) =>
        i === 2 ? { ...f, stage: 'setup' as const } : f,
      ),
      edit: { by: 'reviewer', at: '2026-08-15T09:00:00Z', against: 'sha256:abc', reviewed: true },
    };
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: onDisk, edit: onDisk },
    ];

    const { result } = renderHook(() => useShotLab());

    // Exactly what `loadEtlClips` hands the reducer: `adaptSession`'s output.
    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [adaptSwing(onDisk)],
        entries,
        session: 'IMG_0304',
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/swings/IMG_0304/swings/swing_001/user-edit');
    const sent = JSON.parse(init.body) as EtlSwingDoc;

    // Byte-identical apart from edit.at.
    expect({ ...sent, edit: null }).toEqual({ ...onDisk, edit: null });
    expect(sent.edit?.at).not.toBe(onDisk.edit?.at);
    expect({ ...sent.edit, at: '' }).toEqual({ ...onDisk.edit, at: '' });
  });

  it('preserves a stage the ETL grid no longer knows about, through the whole stack', async () => {
    // C1 end to end. `overlay()` drops a frame whose `source_ms` metadata does
    // not carry FROM THE MERGED VIEW and leaves it on disk, so re-extracting at
    // the original --fps recovers the tag. `entry.doc` is that merged view, so a
    // bare page load used to PUT a document without the orphan and delete it
    // permanently — no user action required.
    const base = realSwing as unknown as EtlSwingDoc;
    const editBlock = {
      by: 'reviewer',
      at: '2026-08-15T09:00:00Z',
      against: 'sha256:abc',
      reviewed: true,
    };
    // `overlayEdit` carries the edit block onto the merged doc, which is what
    // makes `adaptSwing` derive `triaged: true` and the write-back fire at all.
    const merged: EtlSwingDoc = { ...base, edit: editBlock };
    const ORPHAN_MS = merged.frames[24].source_ms + 16;
    const diskEdit: EtlSwingDoc = {
      ...base,
      frames: [
        ...base.frames,
        {
          file: 'frames/frame_0099.jpg',
          source_ms: ORPHAN_MS,
          clip_ms: 816,
          offset_contact_ms: 16,
          pose_score: null,
          stage: 'contact',
        },
      ],
      edit: editBlock,
    };
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: merged, edit: diskEdit },
    ];

    const { result } = renderHook(() => useShotLab());
    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [adaptSwing(merged)],
        entries,
        session: 'IMG_0304',
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });

    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as EtlSwingDoc;
    const orphan = sent.frames.find((f) => f.source_ms === ORPHAN_MS);
    expect(orphan?.stage).toBe('contact');
    expect(sent.frames).toHaveLength(50);
    // Still strictly increasing, so schema.py:206 accepts what we wrote.
    const ms = sent.frames.map((f) => f.source_ms);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it('retries after a rejected write instead of caching it as sent', async () => {
    // `fetch` resolves for 4xx/5xx, so caching without checking `res.ok` retired
    // the label permanently on a 404 or a 400.
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing as never, edit: null },
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

describe('attribution and staleness through the whole write-back effect', () => {
  /**
   * The store-level half of the `edit.by` / `edit.against` fix. `store.ts` used to
   * hardcode `'reviewer'` and always pass `entry.hash`, so the load-time
   * write-back — which fires with no human action at all — rewrote both.
   */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A `user-edit.json` another reviewer wrote, against an OLDER render. */
  const foreignEdit = {
    by: 'coach-ana',
    at: '2026-08-10T09:00:00Z',
    against: 'sha256:OLD',
    reviewed: true,
  };

  const onDisk = (): EtlSwingDoc => ({
    ...(realSwing as unknown as EtlSwingDoc),
    labels: {
      ...(realSwing as unknown as EtlSwingDoc).labels,
      stroke: 'backhand' as const,
      quality: 5 as const,
      notes: 'wrist lag',
    },
    edit: foreignEdit,
  });

  /** Hydrates one previously-reviewed swing and returns the single PUT body. */
  const loadAndCapture = async (doc: EtlSwingDoc) => {
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:CURRENT', doc, edit: doc },
    ];
    const hook = renderHook(() => useShotLab());
    act(() => {
      hook.result.current.dispatch({
        type: 'hydrate',
        clips: [adaptSwing(doc)],
        entries,
        session: 'IMG_0304',
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const sent = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as EtlSwingDoc;
    return { hook, sent };
  };

  it('a bare page load does not launder another reviewer’s name to "reviewer"', async () => {
    const { sent } = await loadAndCapture(onDisk());
    expect(sent.edit?.by).toBe('coach-ana');
  });

  it('a bare page load does not erase the stale-review marker', async () => {
    // `entry.hash` is 'sha256:CURRENT' — the render on disk NOW — while the file
    // says it was reviewed against 'sha256:OLD'. That difference is the only thing
    // that makes `overlay()` warn, and it has to survive a load with no user action.
    const { sent } = await loadAndCapture(onDisk());
    expect(sent.edit?.against).toBe('sha256:OLD');
  });

  it('stamps this reviewer once the human actually edits something', async () => {
    const { hook } = await loadAndCapture(onDisk());
    act(() => {
      hook.result.current.dispatch({
        type: 'setNote',
        clip: 'IMG_0304/swing_001',
        note: 'shanked it',
      });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });
    const sent = JSON.parse(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    ) as EtlSwingDoc;
    expect(sent.labels.notes).toBe('shanked it');
    // Now the labels on disk ARE this reviewer's, reviewed against this render.
    expect(sent.edit?.by).toBe('reviewer');
    expect(sent.edit?.against).toBe('sha256:CURRENT');
  });

  it('still writes nothing new on a bare reload, so dedup is not broken', async () => {
    // The property §1 established, which preserving `by`/`against` must not cost:
    // the cache compares the payload with `edit.at` blanked, and `by`/`against`
    // are now part of that payload — so they have to be STABLE across two
    // load-only projections, not just correct on the first.
    const { hook } = await loadAndCapture(onDisk());

    // Re-run the effect for real without changing anything: `setNote` to the
    // note that is already there rebuilds the clips array, changing the dep's
    // identity while leaving the payload identical.
    const sameNote = clip(hook.result.current.state, 'IMG_0304/swing_001').note;
    act(() => {
      hook.result.current.dispatch({
        type: 'setNote',
        clip: 'IMG_0304/swing_001',
        note: sameNote,
      });
    });
    hook.rerender();

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send a document with a non-string tag the ETL would reject', async () => {
    // Fix 2 through the real effect. `overlay()` lifts `tags` out of
    // `user-edit.json` with no validation, so this is what a hand edit hands over.
    const junk = {
      ...onDisk(),
      labels: { ...onDisk().labels, tags: ['reel', 1, null] },
    } as unknown as EtlSwingDoc;
    const { sent } = await loadAndCapture(junk);
    expect(sent.labels.tags).toEqual(['reel']);
    // And repairing it is not a review, so attribution still survives.
    expect(sent.edit?.by).toBe('coach-ana');
  });
});

describe('the dedup cache and the preserved edit block', () => {
  /**
   * The cache key used to strip `edit` off entirely. That was sound while `edit`
   * was a pure function of the payload — `by` was a constant and `against` was
   * always `entry.hash`.
   *
   * It is no longer. `by`/`against` now depend on whether the human changed
   * anything, and SANITISING can collapse two projections that disagree about
   * that onto the same `labels`: an illegal `quality: 9` on disk is written as
   * `null` whether it was preserved verbatim (no human action) or replaced by a
   * reviewer clearing the rating. Same payload, different attribution — so a key
   * that ignored `edit` suppressed the PUT that records the human's own call.
   *
   * `edit.at` is still excluded: it is this write's clock, so including it would
   * defeat the cache entirely.
   */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the attribution change even when the sanitised labels are identical', async () => {
    // `quality: 9` is outside QUALITY, so `sanitiseLabels` writes null either way.
    const disk = {
      ...(realSwing as unknown as EtlSwingDoc),
      labels: { ...(realSwing as unknown as EtlSwingDoc).labels, quality: 9 },
      edit: { by: 'coach-ana', at: '2026-08-10T09:00:00Z', against: 'sha256:OLD', reviewed: true },
    } as unknown as EtlSwingDoc;
    const entries: SwingEntry[] = [
      { dir: 'swings/swing_001', hash: 'sha256:CURRENT', doc: disk, edit: disk },
    ];

    const { result } = renderHook(() => useShotLab());
    act(() => {
      result.current.dispatch({
        type: 'hydrate',
        clips: [adaptSwing(disk)],
        entries,
        session: 'IMG_0304',
      });
    });

    // Load-only write: nothing changed, so coach-ana keeps the file.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const first = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as EtlSwingDoc;
    expect(first.labels.quality).toBeNull();
    expect(first.edit?.by).toBe('coach-ana');

    // `qualityToGrade(9)` is 'good', so re-picking 'good' CLEARS the rating —
    // one click, and now the human has deliberately said "no rating".
    expect(clip(result.current.state, 'IMG_0304/swing_001').grade).toBe('good');
    act(() => {
      result.current.dispatch({ type: 'setGrade', clip: 'IMG_0304/swing_001', grade: 'good' });
    });
    expect(clip(result.current.state, 'IMG_0304/swing_001').grade).toBeNull();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });
    const second = JSON.parse(
      (fetchMock.mock.calls[1] as [string, { body: string }])[1].body,
    ) as EtlSwingDoc;
    // Byte-identical labels...
    expect(second.labels).toEqual(first.labels);
    // ...but this is the reviewer's own call now, against the render they saw.
    expect(second.edit?.by).toBe('reviewer');
    expect(second.edit?.against).toBe('sha256:CURRENT');
  });
});

describe('the unreadable-swing report reaches the UI', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it('carries what the loader skipped into state, so it can be shown', async () => {
    // Without this the count dies inside `loadEtlClips` and the reviewer reads a
    // 41-swing session as though it were the whole 42.
    const skipped = [{ dir: 'swings/swing_007', reason: 'stroke.charAt is not a function' }];
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue({
      clips: [adaptSwing(realSwing as unknown as EtlSwingDoc)],
      entries: [],
      session: 'IMG_0304',
      sessions: ['IMG_0304'],
      source: null,
      skipped,
    });
    const { result } = renderHook(() => useShotLab());
    await waitFor(() => expect(result.current.state.session).toBe('IMG_0304'));
    expect(result.current.state.skipped).toEqual(skipped);
  });

  it('starts with nothing skipped, and a hydrate reporting none leaves it empty', () => {
    expect(initialState().skipped).toEqual([]);
    const hydrated = reducer(initialState(), {
      type: 'hydrate',
      clips: [],
      entries: [],
      session: 'IMG_0304',
    });
    expect(hydrated.skipped).toEqual([]);
  });
});

describe('switching sessions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const swing = (): EtlSwingDoc => realSwing as unknown as EtlSwingDoc;
  const entriesOf = (): SwingEntry[] => [
    { dir: 'swings/swing_001', hash: 'sha256:abc', doc: swing(), edit: null },
  ];

  const payloadFor = (session: string) => ({
    clips: [adaptSwing(swing())],
    entries: entriesOf(),
    session,
    sessions: ['IMG_0304', 'IMG_0305'],
    source: null,
    skipped: [],
  });

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-reads the tree for the session the reviewer picked', async () => {
    const load = vi
      .spyOn(etlSource, 'loadEtlClips')
      .mockResolvedValue(payloadFor('IMG_0304'));

    const { result } = renderHook(() => useShotLab());
    await waitFor(() => expect(result.current.state.session).toBe('IMG_0304'));
    expect(load).toHaveBeenCalledWith(undefined);

    load.mockResolvedValue(payloadFor('IMG_0305'));
    act(() => result.current.switchSession('IMG_0305'));

    await waitFor(() => expect(result.current.state.session).toBe('IMG_0305'));
    expect(load).toHaveBeenLastCalledWith('IMG_0305');
  });

  it('offers every session in the tree, not only the one loaded', async () => {
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue(payloadFor('IMG_0304'));
    const { result } = renderHook(() => useShotLab());
    await waitFor(() => expect(result.current.state.sessions).toEqual(['IMG_0304', 'IMG_0305']));
  });

  it('flushes an edit made inside the debounce window before switching away', async () => {
    // The write effect cancels on a session change, and a switch changes it —
    // so without the flush a label applied in the last 600 ms goes nowhere, and
    // `hydrate` then replaces the clip that held it.
    vi.spyOn(etlSource, 'loadEtlClips').mockResolvedValue(payloadFor('IMG_0304'));
    const { result } = renderHook(() => useShotLab());
    await waitFor(() => expect(result.current.state.session).toBe('IMG_0304'));
    fetchMock.mockClear();

    act(() => {
      result.current.dispatch({
        type: 'setNote',
        clip: 'IMG_0304/swing_001',
        note: 'switched too fast',
      });
    });
    // No waiting: straight to the switch, well inside the 600 ms debounce.
    act(() => result.current.switchSession('IMG_0305'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('/api/swings/IMG_0304/swings/swing_001/user-edit');
    expect((JSON.parse(init.body) as EtlSwingDoc).labels.notes).toBe('switched too fast');
  });

  it('does not let one session’s sent-payload cache retire another’s write', async () => {
    // Every session names its first swing `swings/swing_001`. Keyed by dir
    // alone, an identical first write to IMG_0305 would be skipped as already
    // sent — silently, and permanently for that page load.
    const load = vi
      .spyOn(etlSource, 'loadEtlClips')
      .mockResolvedValue(payloadFor('IMG_0304'));
    const { result } = renderHook(() => useShotLab());
    await waitFor(() => expect(result.current.state.session).toBe('IMG_0304'));

    act(() => {
      result.current.dispatch({ type: 'setNote', clip: 'IMG_0304/swing_001', note: 'same text' });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 1000 });
    fetchMock.mockClear();

    load.mockResolvedValue(payloadFor('IMG_0305'));
    act(() => result.current.switchSession('IMG_0305'));
    await waitFor(() => expect(result.current.state.session).toBe('IMG_0305'));
    fetchMock.mockClear();

    act(() => {
      result.current.dispatch({ type: 'setNote', clip: 'IMG_0304/swing_001', note: 'same text' });
    });

    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
          '/api/swings/IMG_0305/swings/swing_001/user-edit',
        );
      },
      { timeout: 1000 },
    );
  });
});

describe('playing a clip in the inspector', () => {
  const withFrames = (id: string, phases: Array<Phase | null>): Clip => ({
    id,
    player: 'left',
    stroke: null,
    rejected: false,
    duration: '0:03',
    triaged: false,
    grade: null,
    note: '',
    frames: phases.map((phase, i) => ({ i, sourceMs: i * 500, phase })),
  });

  const docWith = (clips: Clip[]): State => {
    const base = initialState();
    return { ...base, doc: { ...base.doc, clips } };
  };

  it('selects the anchor frame and starts playing, without opening the clip', () => {
    // The point of the design change: answer "was that a shot?" beside the grid
    // rather than navigating away and losing your place in it.
    const state = docWith([withFrames('A', [null, null, 'contact', null])]);
    const next = reducer(state, { type: 'playClip', clip: 'A' });
    expect(next.ui.inspectorPlaying).toBe(true);
    expect(next.ui.sel).toEqual({ clip: 'A', frame: 2 });
    expect(next.ui.view).toBe('compare');
    expect(next.ui.detail).toBeNull();
  });

  it('prefers the frame the grid is aligned on', () => {
    const state = {
      ...docWith([withFrames('A', ['setup', null, 'contact', null])]),
    };
    const aligned = { ...state, ui: { ...state.ui, anchor: 'setup' as Phase } };
    expect(reducer(aligned, { type: 'playClip', clip: 'A' }).ui.sel).toEqual({
      clip: 'A',
      frame: 0,
    });
  });

  it('falls back to the detector’s contact frame, then to the first', () => {
    const untagged = docWith([
      {
        ...withFrames('A', [null, null, null]),
        frames: [
          { i: 0, sourceMs: 0, phase: null },
          { i: 1, sourceMs: 500, phase: null, offsetContactMs: 0 },
          { i: 2, sourceMs: 1000, phase: null },
        ],
      },
    ]);
    expect(reducer(untagged, { type: 'playClip', clip: 'A' }).ui.sel?.frame).toBe(1);

    const bare = docWith([withFrames('B', [null, null])]);
    expect(reducer(bare, { type: 'playClip', clip: 'B' }).ui.sel?.frame).toBe(0);
  });

  it('ignores a clip that is not there, and one with no frames', () => {
    const state = docWith([{ ...withFrames('A', []), frames: [] }]);
    expect(reducer(state, { type: 'playClip', clip: 'A' })).toBe(state);
    expect(reducer(state, { type: 'playClip', clip: 'nope' })).toBe(state);
  });

  it('stops playing when the reviewer picks a frame', () => {
    // They just said which moment they want to look at; letting the clip run on
    // would carry them straight off it.
    const playing = reducer(
      docWith([withFrames('A', [null, 'contact', null])]),
      { type: 'playClip', clip: 'A' },
    );
    const picked = reducer(playing, { type: 'select', clip: 'A', frame: 0 });
    expect(picked.ui.inspectorPlaying).toBe(false);
    expect(picked.ui.sel).toEqual({ clip: 'A', frame: 0 });
  });

  it('stops playing when the selection is cleared', () => {
    const playing = reducer(
      docWith([withFrames('A', ['contact'])]),
      { type: 'playClip', clip: 'A' },
    );
    expect(reducer(playing, { type: 'clearSelection' }).ui.inspectorPlaying).toBe(false);
  });

  it('toggles, and is inert with nothing selected', () => {
    const empty = initialState();
    const nothingSelected = { ...empty, ui: { ...empty.ui, sel: null } };
    expect(reducer(nothingSelected, { type: 'toggleInspectorPlay' })).toBe(nothingSelected);

    const playing = reducer(
      docWith([withFrames('A', ['contact'])]),
      { type: 'playClip', clip: 'A' },
    );
    expect(reducer(playing, { type: 'toggleInspectorPlay' }).ui.inspectorPlaying).toBe(false);
  });

  it('leaves the detail view’s own transport alone', () => {
    // Two players, two flags: watching in the inspector must not start the
    // detail view playing behind it.
    const playing = reducer(
      docWith([withFrames('A', ['contact'])]),
      { type: 'playClip', clip: 'A' },
    );
    expect(playing.ui.playing).toBe(false);
  });
});

describe('changing the source video', () => {
  it('drops the selection, the open clip and the running player', () => {
    // Each of those names a swing in the tree being navigated away from.
    const base = initialState();
    const busy: State = {
      ...base,
      ui: {
        ...base.ui,
        sel: { clip: 'IMG_0304/swing_001', frame: 3 },
        detail: 'IMG_0304/swing_001',
        view: 'detail',
        draft: 'half-typed',
        inspectorPlaying: true,
        sourceMetaOpen: true,
      },
    };
    const next = reducer(busy, { type: 'requestSession', session: 'IMG_0305' });
    expect(next.requested).toBe('IMG_0305');
    expect(next.ui.sel).toBeNull();
    expect(next.ui.detail).toBeNull();
    expect(next.ui.view).toBe('compare');
    expect(next.ui.draft).toBe('');
    expect(next.ui.inspectorPlaying).toBe(false);
    expect(next.ui.sourceMetaOpen).toBe(false);
  });

  it('leaves a catalog reviewer in the catalog', () => {
    // Only `detail` is tied to one clip; the grid views survive the switch.
    const base = initialState();
    const inCatalog: State = { ...base, ui: { ...base.ui, view: 'catalog' } };
    expect(reducer(inCatalog, { type: 'requestSession', session: 'IMG_0305' }).ui.view).toBe(
      'catalog',
    );
  });

  it('opens and closes the source details popover', () => {
    const opened = reducer(initialState(), { type: 'setSourceMetaOpen', value: true });
    expect(opened.ui.sourceMetaOpen).toBe(true);
    expect(reducer(opened, { type: 'setSourceMetaOpen', value: false }).ui.sourceMetaOpen).toBe(
      false,
    );
  });
});

describe('shortId', () => {
  it('drops the session prefix the header already names', () => {
    expect(shortId('IMG_0305/swing_042')).toBe('swing_042');
  });

  it('leaves an id with no prefix alone, which is what the seed carries', () => {
    expect(shortId('SL-002')).toBe('SL-002');
  });
});

describe('playing inline in the catalog', () => {
  it('plays one card without opening the inspector panel', () => {
    // The catalog card is already the size of a player; opening a panel to
    // watch something you can see is a detour.
    const next = reducer(initialState(), { type: 'playInline', clip: 'IMG_0305/swing_004' });
    expect(next.ui.inlineClip).toBe('IMG_0305/swing_004');
    expect(next.ui.inspectorPlaying).toBe(false);
    expect(next.ui.view).toBe('compare');
    expect(next.ui.detail).toBeNull();
  });

  it('stops the panel’s player when a card starts', () => {
    const base = initialState();
    const panelPlaying = { ...base, ui: { ...base.ui, inspectorPlaying: true } };
    expect(
      reducer(panelPlaying, { type: 'playInline', clip: 'A' }).ui.inspectorPlaying,
    ).toBe(false);
  });

  it('plays one clip at a time', () => {
    const first = reducer(initialState(), { type: 'playInline', clip: 'A' });
    expect(reducer(first, { type: 'playInline', clip: 'B' }).ui.inlineClip).toBe('B');
  });

  it('stops when passed null, which is what the clip ending sends', () => {
    const playing = reducer(initialState(), { type: 'playInline', clip: 'A' });
    expect(reducer(playing, { type: 'playInline', clip: null }).ui.inlineClip).toBeNull();
  });

  it('picking a frame stops the card, so the still is not behind a video', () => {
    const playing = reducer(initialState(), { type: 'playInline', clip: 'A' });
    const picked = reducer(playing, { type: 'select', clip: 'A', frame: 2 });
    expect(picked.ui.inlineClip).toBeNull();
    expect(picked.ui.sel).toEqual({ clip: 'A', frame: 2 });
  });
});

describe('the phone layout', () => {
  it('keeps the drawer and the sidebar as separate flags', () => {
    // They are different things wearing the same name: the sidebar is open by
    // default and pushes the grid aside; the drawer starts closed and floats
    // over it. One flag meant closing the drawer on a phone collapsed the
    // sidebar for the next desktop session.
    const base = initialState();
    expect(base.ui.filtersOpen).toBe(true);
    expect(base.ui.mobileFilters).toBe(false);

    const drawerOpen = reducer(base, { type: 'toggleMobileFilters' });
    expect(drawerOpen.ui.mobileFilters).toBe(true);
    expect(drawerOpen.ui.filtersOpen).toBe(true);

    const sidebarShut = reducer(drawerOpen, { type: 'toggleFilters' });
    expect(sidebarShut.ui.filtersOpen).toBe(false);
    expect(sidebarShut.ui.mobileFilters).toBe(true);
  });

  it('expands and collapses the inspector sheet', () => {
    const full = reducer(initialState(), { type: 'setSheetFull', value: true });
    expect(full.ui.sheetFull).toBe(true);
    expect(reducer(full, { type: 'setSheetFull', value: false }).ui.sheetFull).toBe(false);
  });

  it('collapses the sheet when the selection is dismissed', () => {
    // Otherwise the next frame picked raises an already-expanded sheet over
    // the clip it was picked from.
    const base = initialState();
    const expanded: State = {
      ...base,
      ui: { ...base.ui, sheetFull: true, sel: { clip: 'A', frame: 1 } },
    };
    const dismissed = reducer(expanded, { type: 'clearSelection' });
    expect(dismissed.ui.sheetFull).toBe(false);
    expect(dismissed.ui.sel).toBeNull();
  });
});
