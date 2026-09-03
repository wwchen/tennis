import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { Clip, Grade, Phase, Selection, Stroke, View } from '@/domain/types';
import { ADD_PLAYER, ALL_PLAYERS, ALL_RATINGS, ALL_STROKES } from '@/domain/types';
import { SEED_NEXT_COMMENT_ID, SEED_REMOVED_STACK, seedClips, seedComments } from '@/domain/seed';
import type { EtlProxy, EtlSource, SwingEntry } from '@/domain/etl-types';
import type { SkippedSwing } from '@/domain/etl';
import { toUserEdit } from '@/domain/etl-write';
import type { Doc } from './persistence';
import { loadDoc, saveDoc } from './persistence';
import { loadEtlClips } from './etl-source';

/** Everything that is a view preference rather than coaching data. */
export interface Ui {
  view: View;
  playerFilter: string;
  strokeFilter: string;
  gradeFilter: string;
  anchor: Phase;
  onlyAnchor: boolean;
  lowOnly: boolean;
  /** Show only the swings whose measurements read as "nobody hit anything". */
  suspectOnly: boolean;
  showRejected: boolean;
  filtersOpen: boolean;
  /**
   * Whether the phone's filter drawer is open. Separate from `filtersOpen`.
   *
   * They are different things wearing the same name: on a desktop the filters
   * are a column that pushes the grid aside; on a phone they are a drawer over
   * the top of it. Both start closed now, but for different reasons, and they
   * still cannot share a flag — closing the drawer on a phone would collapse
   * the sidebar for the next desktop session.
   */
  mobileFilters: boolean;
  /** Whether the phone's inspector sheet is expanded to full height. */
  sheetFull: boolean;
  sel: Selection | null;
  detail: string | null;
  draft: string;
  playing: boolean;
  /** Whether the header's source-details popover is open. */
  sourceMetaOpen: boolean;
  /**
   * The catalog card playing its clip in place, if any.
   *
   * Deliberately NOT `sel` + `inspectorPlaying`: in the catalog the card is
   * already the size of a player, so opening a panel to watch a clip you can
   * see is a detour. One clip at a time, because several playing at once is
   * noise, not a contact sheet.
   */
  inlineClip: string | null;
  /**
   * Whether the inspector's clip is playing.
   *
   * Separate from `playing`, which drives the detail view's own transport. The
   * design puts a second player in the inspector precisely so a reviewer can
   * watch a clip WITHOUT leaving the compare grid, so the two have to be able
   * to disagree.
   */
  inspectorPlaying: boolean;
  /** Clip id whose stroke chip is currently swapped for a dropdown. */
  editingStroke: string | null;
  editingPlayer: string | null;
  addingPlayer: boolean;
  newPlayer: string;
}

export interface State {
  doc: Doc;
  ui: Ui;
  /** ETL source docs, for write-back. Not persisted — they are not coaching data. */
  entries: SwingEntry[];
  /** Session name from the ETL tree. Not persisted. */
  session: string | null;
  /** Every session the tree offers, for the picker. Not persisted. */
  sessions: string[];
  /** Sessions whose source video exists — what the keyframe picker offers. */
  playable: string[];
  /** What the ETL probed about the source video. Not persisted. */
  source: EtlSource | null;
  /**
   * The session's full-length playable video, or null when there is none.
   *
   * Null means the review falls back to per-swing clips: an older tree, or a
   * session whose source video was gone when the proxy would have been built.
   */
  proxy: EtlProxy | null;
  /** The detector's tuning and reject histogram for this session. */
  settings: Record<string, unknown> | null;
  detection: Record<string, unknown> | null;
  /**
   * The session the reviewer asked for, or null for "whichever comes first".
   *
   * Separate from `session`, which is what the server answered with. The load
   * effect keys off this one, so setting it is what triggers a re-read; keeping
   * them apart is also what stops a hydrate from re-triggering its own load.
   */
  requested: string | null;
  /**
   * Swings in the tree the read path could not adapt. Surfaced in the header,
   * because a session silently short of some of its swings is indistinguishable
   * from a complete one.
   */
  skipped: SkippedSwing[];
}

export type Action =
  // `skipped` is optional so a test hydrating a clean session need not say
  // "nothing was skipped" — absent means none. `sessions` is optional for the
  // same reason: absent means the tree holds only the one being hydrated.
  | {
      type: 'hydrate';
      clips: Clip[];
      entries: SwingEntry[];
      session: string;
      sessions?: string[];
      playable?: string[];
      source?: EtlSource | null;
      proxy?: EtlProxy | null;
      settings?: Record<string, unknown> | null;
      detection?: Record<string, unknown> | null;
      skipped?: SkippedSwing[];
    }
  | { type: 'requestSession'; session: string }
  | { type: 'setView'; view: View }
  | { type: 'setPlayerFilter'; value: string }
  | { type: 'setStrokeFilter'; value: string }
  | { type: 'setGradeFilter'; value: string }
  | { type: 'setAnchor'; anchor: Phase }
  | { type: 'setOnlyAnchor'; value: boolean }
  | { type: 'setLowOnly'; value: boolean }
  | { type: 'setSuspectOnly'; value: boolean }
  | { type: 'setShowRejected'; value: boolean }
  | { type: 'toggleFilters' }
  | { type: 'toggleMobileFilters' }
  | { type: 'setSheetFull'; value: boolean }
  | { type: 'toggleShowRemoved' }
  | { type: 'select'; clip: string; frame: number }
  | { type: 'clearSelection' }
  | { type: 'openDetail'; clip: string }
  | { type: 'closeDetail' }
  | { type: 'togglePlay' }
  | { type: 'playClip'; clip: string }
  | { type: 'toggleInspectorPlay' }
  | { type: 'setSourceMetaOpen'; value: boolean }
  | { type: 'playInline'; clip: string | null }
  | { type: 'setGrade'; clip: string; grade: Grade }
  | { type: 'clearGrade'; clip: string }
  | { type: 'setClipStroke'; clip: string; stroke: Stroke }
  | { type: 'setClipPlayer'; clip: string; player: string }
  | { type: 'setNote'; clip: string; note: string }
  | { type: 'toggleReject'; clip: string }
  | { type: 'undoRemove' }
  | { type: 'setPhase'; clip: string; frame: number; phase: Phase | null }
  | { type: 'editStroke'; clip: string | null }
  | { type: 'editPlayer'; clip: string | null }
  | { type: 'setNewPlayer'; value: string }
  | { type: 'commitNewPlayer' }
  | { type: 'cancelNewPlayer' }
  | { type: 'setDraft'; value: string }
  | { type: 'postComment' }
  | { type: 'stopEditing' };

const freshDoc = (): Doc => ({
  clips: seedClips(),
  comments: seedComments(),
  extraPlayers: [],
  removedStack: [...SEED_REMOVED_STACK],
  nextCommentId: SEED_NEXT_COMMENT_ID,
});

const initialUi = (): Ui => ({
  view: 'keyframes',
  playerFilter: ALL_PLAYERS,
  strokeFilter: ALL_STROKES,
  gradeFilter: ALL_RATINGS,
  anchor: 'contact',
  onlyAnchor: false,
  lowOnly: false,
  suspectOnly: false,
  showRejected: false,
  // Collapsed to start. The filters are a refinement, not a first step: the
  // catalog is what the session is for, and the column was taking 268px of it
  // away from every reviewer who opened the app to look at clips.
  filtersOpen: false,
  mobileFilters: false,
  sheetFull: false,
  sel: { clip: 'SL-002', frame: 5 },
  detail: null,
  draft: '',
  playing: false,
  inspectorPlaying: false,
  sourceMetaOpen: false,
  inlineClip: null,
  editingStroke: null,
  editingPlayer: null,
  addingPlayer: false,
  newPlayer: '',
});

export const initialState = (): State => ({
  doc: loadDoc() ?? freshDoc(),
  ui: initialUi(),
  entries: [],
  session: null,
  sessions: [],
  playable: [],
  source: null,
  proxy: null,
  settings: null,
  detection: null,
  requested: null,
  skipped: [],
});

/** Patches one clip in place, leaving every other clip's identity untouched. */
const patchClip = (
  doc: Doc,
  id: string,
  patch: (c: Doc['clips'][number]) => Doc['clips'][number],
): Doc => ({
  ...doc,
  clips: doc.clips.map((c) => (c.id === id ? patch(c) : c)),
});

const ui = (state: State, patch: Partial<Ui>): State => ({ ...state, ui: { ...state.ui, ...patch } });

export function reducer(state: State, action: Action): State {
  const { doc } = state;

  switch (action.type) {
    case 'hydrate':
      // Replaces the seed wholesale. Comments are seeded scratch data pinned to
      // seed clip ids, so they go too rather than dangle on ids that no longer
      // exist.
      return {
        ...state,
        doc: { ...doc, clips: action.clips, comments: [], removedStack: [] },
        ui: { ...state.ui, sel: null, detail: null, draft: '' },
        entries: action.entries,
        session: action.session,
        sessions: action.sessions ?? [action.session],
        playable: action.playable ?? [],
        source: action.source ?? null,
        proxy: action.proxy ?? null,
        settings: action.settings ?? null,
        detection: action.detection ?? null,
        skipped: action.skipped ?? [],
      };
    case 'requestSession':
      // Only the request is recorded here. The load effect watches it, fetches,
      // and comes back through `hydrate` — so the clips on screen stay the ones
      // whose `session` write-back is still addressing until the new tree has
      // actually been read.
      // The view resets with the source, as the design has it: a selection, an
      // open detail pane and a running clip all name a swing in the tree being
      // navigated away from, and carrying them across would leave the inspector
      // pointing at a clip that is no longer loaded.
      return {
        ...state,
        requested: action.session,
        ui: {
          ...state.ui,
          sel: null,
          detail: null,
          view: state.ui.view === 'detail' ? 'compare' : state.ui.view,
          draft: '',
          inspectorPlaying: false,
          sourceMetaOpen: false,
        },
      };
    case 'setView':
      return ui(state, { view: action.view });
    case 'setPlayerFilter':
      return ui(state, { playerFilter: action.value });
    case 'setStrokeFilter':
      return ui(state, { strokeFilter: action.value });
    case 'setGradeFilter':
      return ui(state, { gradeFilter: action.value });
    case 'setAnchor':
      return ui(state, { anchor: action.anchor });
    case 'setOnlyAnchor':
      return ui(state, { onlyAnchor: action.value });
    case 'setLowOnly':
      return ui(state, { lowOnly: action.value });
    case 'setSuspectOnly':
      return ui(state, { suspectOnly: action.value });
    case 'setShowRejected':
      return ui(state, { showRejected: action.value });
    case 'toggleFilters':
      return ui(state, { filtersOpen: !state.ui.filtersOpen });
    case 'toggleMobileFilters':
      return ui(state, { mobileFilters: !state.ui.mobileFilters });
    case 'setSheetFull':
      return ui(state, { sheetFull: action.value });
    case 'toggleShowRemoved':
      return ui(state, { showRejected: !state.ui.showRejected });

    case 'select':
      // Clearing the draft is deliberate: the comment box is bound to whichever
      // frame is selected, so carrying half-typed text to a new frame would pin
      // it somewhere the author never looked at.
      // Picking a frame stops playback: the reviewer just said which moment
      // they want to look at, and letting the clip run on would carry them off
      // it immediately.
      return ui(state, {
        sel: { clip: action.clip, frame: action.frame },
        draft: '',
        inspectorPlaying: false,
        // A still cannot be seen through a running clip, and picking a frame
        // is a request to look at exactly that moment.
        inlineClip: null,
      });
    case 'clearSelection':
      return ui(state, { sel: null, inspectorPlaying: false, sheetFull: false });
    case 'openDetail':
      // A selection belongs to one clip. Carrying it to a different clip ghost-
      // highlighted a frame nobody clicked, and `App.tsx` indexes
      // `selClip.frames[ui.sel.frame]` — a stale index from a longer clip reads
      // as undefined. A selection already on the target clip is kept, so
      // clicking a frame and then opening its clip lands on that frame.
      return ui(state, {
        view: 'detail',
        detail: action.clip,
        sel: state.ui.sel?.clip === action.clip ? state.ui.sel : null,
      });
    case 'closeDetail':
      return ui(state, { view: 'compare', detail: null });
    case 'togglePlay':
      return ui(state, { playing: !state.ui.playing });

    case 'playClip': {
      // Play in the inspector rather than opening the clip: the whole point of
      // the row's play button is to answer "was that a shot?" without losing
      // your place in the grid.
      const clip = doc.clips.find((c) => c.id === action.clip);
      if (clip === undefined || clip.frames.length === 0) return state;
      // The frame the grid is aligned on, so pausing leaves the inspector on
      // the moment the reviewer was already comparing.
      const anchored =
        clip.frames.find((f) => f.phase === state.ui.anchor) ??
        clip.frames.find((f) => f.offsetContactMs === 0) ??
        clip.frames[0];
      return ui(state, {
        sel: { clip: clip.id, frame: anchored.i },
        draft: '',
        inspectorPlaying: true,
      });
    }
    case 'setSourceMetaOpen':
      return ui(state, { sourceMetaOpen: action.value });
    case 'playInline':
      // Starting one card stops the panel's player: two clips running at once
      // is two soundtracks and two things to watch.
      return ui(state, { inlineClip: action.clip, inspectorPlaying: false });
    case 'toggleInspectorPlay':
      // No selection means no clip to play, so the toggle is inert rather than
      // leaving `inspectorPlaying` true with nothing on screen.
      if (state.ui.sel === null) return state;
      return ui(state, { inspectorPlaying: !state.ui.inspectorPlaying });

    case 'setGrade':
      // Re-picking the grade a clip already carries clears it, so the same chip
      // both rates and un-rates.
      return {
        ...state,
        doc: patchClip(doc, action.clip, (c) => ({
          ...c,
          grade: c.grade === action.grade ? null : action.grade,
          triaged: true,
        })),
      };
    case 'clearGrade':
      return { ...state, doc: patchClip(doc, action.clip, (c) => ({ ...c, grade: null })) };

    case 'setClipStroke':
      return {
        ...state,
        doc: patchClip(doc, action.clip, (c) => ({ ...c, stroke: action.stroke, triaged: true })),
        ui: { ...state.ui, editingStroke: null },
      };

    case 'setClipPlayer':
      if (action.player === ADD_PLAYER) {
        return ui(state, { addingPlayer: true, newPlayer: '', editingPlayer: action.clip });
      }
      return {
        ...state,
        doc: patchClip(doc, action.clip, (c) => ({ ...c, player: action.player, triaged: true })),
        ui: { ...state.ui, editingPlayer: null },
      };

    case 'setNote':
      // `triaged` gates write-back, so a note that does not set it is written
      // to localStorage and never reaches user-edit.json.
      return {
        ...state,
        doc: patchClip(doc, action.clip, (c) => ({ ...c, note: action.note, triaged: true })),
      };

    case 'toggleReject': {
      const target = doc.clips.find((c) => c.id === action.clip);
      if (!target) return state;
      const rejected = !target.rejected;
      return {
        ...state,
        doc: {
          // Rejecting is a human verdict like any other, and gates write-back
          // the same way; see `setNote`.
          ...patchClip(doc, action.clip, (c) => ({ ...c, rejected, triaged: true })),
          removedStack: rejected
            ? [...doc.removedStack, action.clip]
            : doc.removedStack.filter((id) => id !== action.clip),
        },
      };
    }

    case 'undoRemove': {
      // Only the stack. The old fallback to "any rejected clip" fired after
      // every reload -- hydrate clears the stack, `rejected` is re-read from
      // disk -- and wrote `verdict: valid` to a swing nobody had judged.
      const last = doc.removedStack.at(-1);
      if (last === undefined) return state;
      return reducer(state, { type: 'toggleReject', clip: last });
    }

    case 'setPhase':
      // A phase is unique within a clip: assigning it here strips it from
      // whichever frame held it before. Confidence goes to 1 because a human
      // just made the call.
      return {
        ...state,
        doc: patchClip(doc, action.clip, (c) => ({
          ...c,
          triaged: true,
          frames: c.frames.map((f) => {
            if (f.i === action.frame) return { ...f, phase: action.phase, conf: 1 };
            if (action.phase !== null && f.phase === action.phase) return { ...f, phase: null };
            return f;
          }),
        })),
      };

    case 'editStroke':
      return ui(state, { editingStroke: action.clip });
    case 'editPlayer':
      return ui(state, { editingPlayer: action.clip });
    case 'stopEditing':
      return ui(state, { editingStroke: null, editingPlayer: null });

    case 'setNewPlayer':
      return ui(state, { newPlayer: action.value });
    case 'cancelNewPlayer':
      return ui(state, { addingPlayer: false, newPlayer: '', editingPlayer: null });
    case 'commitNewPlayer': {
      const name = state.ui.newPlayer.trim();
      const target = state.ui.editingPlayer;
      if (name === '' || target === null) return state;
      return {
        ...state,
        doc: {
          ...patchClip(doc, target, (c) => ({ ...c, player: name, triaged: true })),
          extraPlayers: doc.extraPlayers.includes(name)
            ? doc.extraPlayers
            : [...doc.extraPlayers, name],
        },
        ui: { ...state.ui, addingPlayer: false, newPlayer: '', editingPlayer: null },
      };
    }

    case 'setDraft':
      return ui(state, { draft: action.value });
    case 'postComment': {
      const text = state.ui.draft.trim();
      const sel = state.ui.sel;
      if (text === '' || sel === null) return state;
      return {
        ...state,
        doc: {
          ...doc,
          comments: [
            ...doc.comments,
            { id: doc.nextCommentId, clip: sel.clip, frame: sel.frame, author: 'Me', at: 'now', text },
          ],
          nextCommentId: doc.nextCommentId + 1,
        },
        ui: { ...state.ui, draft: '' },
      };
    }
  }
}

/**
 * Who `edit.by` names for a write this app's user authored.
 *
 * There is no sign-in, so the app genuinely cannot know a name — this stands in
 * for one, and is deliberately the only place it is written. It is used ONLY for
 * a write that records a real change: a load-time write-back over a file another
 * reviewer or tool wrote carries that file's own `by` through instead, because
 * replacing `"coach-ana"` with this destroys attribution nobody asked to change.
 * See `editFor` in `src/domain/etl-write.ts`.
 */
const REVIEWER = 'reviewer';

export function useShotLab() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const lastSentRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    void loadEtlClips(state.requested ?? undefined).then((payload) => {
      if (live && payload !== null) {
        dispatch({
          type: 'hydrate',
          clips: payload.clips,
          entries: payload.entries,
          session: payload.session,
          sessions: payload.sessions,
          playable: payload.playable,
          source: payload.source,
          proxy: payload.proxy,
          settings: payload.settings,
          detection: payload.detection,
          skipped: payload.skipped,
        });
      }
    });
    return () => {
      live = false;
    };
  }, [state.requested]);

  useEffect(() => {
    saveDoc(state.doc);
  }, [state.doc]);

  /**
   * PUTs every triaged clip whose payload has changed since it was last sent.
   *
   * Extracted from the debounce below so a session switch can flush first. The
   * debounce cancels on `entries`/`session` change, and a switch changes both —
   * so a label applied inside the last 600 ms would otherwise be dropped on the
   * floor with the clips it belonged to.
   */
  const writeAll = useCallback(() => {
    const { session } = state;
    if (session === null) return;
    for (const entry of state.entries) {
      const clip = state.doc.clips.find((c) => c.id === entry.doc.id);
      if (clip === undefined || !clip.triaged) continue;

      // Build the doc without the volatile timestamp so we can compare
      const docWithoutTimestamp = toUserEdit(
        clip,
        entry.doc,
        entry.hash,
        REVIEWER,
        '', // placeholder; we'll replace it below
        // The previous on-disk edit, so frame entries `overlay()` dropped from
        // the merged view survive rather than being erased from disk, and so
        // `edit.by`/`edit.against` survive a write this reviewer did not author.
        entry.edit,
      );
      const { edit, ...rest } = docWithoutTimestamp;
      // `edit.at` is the only volatile field — it is this write's own clock, so
      // including it would defeat the cache entirely and re-PUT every clip on
      // every effect run. The rest of `edit` is part of the payload's identity:
      // `by` and `against` are carried over from the previous file when the
      // human changed nothing, so they can differ between two documents whose
      // `labels` and `frames` agree, and a cache that ignored them could retire
      // a write that does change attribution.
      const payload = JSON.stringify({ ...rest, edit: { ...edit, at: '' } });

      // Skip if this exact payload was already sent. Keyed by session AND
      // dir: every session names its swings `swings/swing_001`, so a bare
      // dir would let one session's cached payload retire the identical
      // first write to another's after a switch.
      const cacheKey = `${session}/${entry.dir}`;
      if (lastSentRef.current.get(cacheKey) === payload) continue;

      // Now stamp the real timestamp and send
      const finalDoc = { ...docWithoutTimestamp, edit: { ...edit, at: new Date().toISOString() } };
      void fetch(`/api/swings/${session}/${entry.dir}/user-edit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalDoc),
      })
        .then((res) => {
          // `fetch` resolves for 4xx/5xx too. Caching a rejected payload as
          // sent would retire that label permanently.
          if (res.ok) lastSentRef.current.set(cacheKey, payload);
        })
        .catch(() => {
          // Dev-only route; a static build has nowhere to write.
        });
    }
  }, [state]);

  useEffect(() => {
    const timer = setTimeout(writeAll, 600);
    return () => clearTimeout(timer);
  }, [writeAll]);

  /**
   * Loads another session, without losing an edit made moments ago.
   *
   * The flush has to happen before the request, not after: `hydrate` replaces
   * `doc.clips` wholesale, so once the new tree arrives the old session's
   * labels are no longer anywhere in state to write.
   */
  const switchSession = useCallback(
    (session: string) => {
      writeAll();
      dispatch({ type: 'requestSession', session });
    },
    [writeAll],
  );

  return useMemo(() => ({ state, dispatch, switchSession }), [state, switchSession]);
}
