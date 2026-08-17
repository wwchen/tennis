import { useEffect, useMemo, useReducer } from 'react';
import type { Clip, Grade, Phase, Selection, Stroke, View } from '@/domain/types';
import { ADD_PLAYER, ALL_PLAYERS, ALL_RATINGS, ALL_STROKES } from '@/domain/types';
import { SEED_NEXT_COMMENT_ID, SEED_REMOVED_STACK, seedClips, seedComments } from '@/domain/seed';
import type { SwingEntry } from '@/domain/etl-types';
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
  showRejected: boolean;
  filtersOpen: boolean;
  sel: Selection | null;
  detail: string | null;
  draft: string;
  playing: boolean;
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
}

export type Action =
  | { type: 'hydrate'; clips: Clip[]; entries: SwingEntry[]; session: string }
  | { type: 'setView'; view: View }
  | { type: 'setPlayerFilter'; value: string }
  | { type: 'setStrokeFilter'; value: string }
  | { type: 'setGradeFilter'; value: string }
  | { type: 'setAnchor'; anchor: Phase }
  | { type: 'setOnlyAnchor'; value: boolean }
  | { type: 'setLowOnly'; value: boolean }
  | { type: 'setShowRejected'; value: boolean }
  | { type: 'toggleFilters' }
  | { type: 'toggleShowRemoved' }
  | { type: 'select'; clip: string; frame: number }
  | { type: 'clearSelection' }
  | { type: 'openDetail'; clip: string }
  | { type: 'closeDetail' }
  | { type: 'togglePlay' }
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
  view: 'compare',
  playerFilter: ALL_PLAYERS,
  strokeFilter: ALL_STROKES,
  gradeFilter: ALL_RATINGS,
  anchor: 'contact',
  onlyAnchor: false,
  lowOnly: false,
  showRejected: false,
  filtersOpen: true,
  sel: { clip: 'SL-002', frame: 5 },
  detail: null,
  draft: '',
  playing: false,
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
    case 'setShowRejected':
      return ui(state, { showRejected: action.value });
    case 'toggleFilters':
      return ui(state, { filtersOpen: !state.ui.filtersOpen });
    case 'toggleShowRemoved':
      return ui(state, { showRejected: !state.ui.showRejected });

    case 'select':
      // Clearing the draft is deliberate: the comment box is bound to whichever
      // frame is selected, so carrying half-typed text to a new frame would pin
      // it somewhere the author never looked at.
      return ui(state, { sel: { clip: action.clip, frame: action.frame }, draft: '' });
    case 'clearSelection':
      return ui(state, { sel: null });
    case 'openDetail':
      return ui(state, { view: 'detail', detail: action.clip });
    case 'closeDetail':
      return ui(state, { view: 'compare', detail: null });
    case 'togglePlay':
      return ui(state, { playing: !state.ui.playing });

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
      return { ...state, doc: patchClip(doc, action.clip, (c) => ({ ...c, note: action.note })) };

    case 'toggleReject': {
      const target = doc.clips.find((c) => c.id === action.clip);
      if (!target) return state;
      const rejected = !target.rejected;
      return {
        ...state,
        doc: {
          ...patchClip(doc, action.clip, (c) => ({ ...c, rejected })),
          removedStack: rejected
            ? [...doc.removedStack, action.clip]
            : doc.removedStack.filter((id) => id !== action.clip),
        },
      };
    }

    case 'undoRemove': {
      // Prefer the most recent removal; fall back to any removed clip so the
      // button still works against a doc restored without a stack.
      const last = doc.removedStack.at(-1) ?? doc.clips.find((c) => c.rejected)?.id;
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

export function useShotLab() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  useEffect(() => {
    let live = true;
    void loadEtlClips().then((payload) => {
      if (live && payload !== null) {
        dispatch({ type: 'hydrate', clips: payload.clips, entries: payload.entries, session: payload.session });
      }
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    saveDoc(state.doc);
  }, [state.doc]);

  useEffect(() => {
    if (state.session === null) return;
    const timer = setTimeout(() => {
      for (const entry of state.entries) {
        const clip = state.doc.clips.find((c) => c.id === entry.doc.id);
        if (clip === undefined || !clip.triaged) continue;
        void fetch(`/api/swings/${state.session}/${entry.dir}/user-edit`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            toUserEdit(clip, entry.doc, entry.hash, 'reviewer', new Date().toISOString()),
          ),
        }).catch(() => {
          // Dev-only route; a static build has nowhere to write.
        });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [state.doc.clips, state.entries, state.session]);

  return useMemo(() => ({ state, dispatch }), [state]);
}
