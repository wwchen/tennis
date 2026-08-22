import type { Clip, Comment, Phase, Stroke } from '@/domain/types';
import { isSuspect } from '@/domain/types';
import {
  ALL_PLAYERS,
  ALL_RATINGS,
  ALL_STROKES,
  CONFIDENCE_FLOOR,
  FRAMES_PER_CLIP,
} from '@/domain/types';
import { frameWindow } from '@/domain/window';
import { gradeOf } from '@/domain/grades';
import type { Doc } from '@/state/persistence';
import type { Ui } from '@/state/store';

/**
 * One position in a compare row. Padding cells (`real: false`) are the gaps
 * that push each clip's anchor frame into the shared column.
 */
export type Cell =
  | { real: false; key: string }
  | {
      real: true;
      key: string;
      clip: string;
      /** Index into the clip's FULL frame list, not into `cells`. */
      frame: number;
      /** Frame label, `f01`…`f49`. */
      num: string;
      phase: Phase | null;
      /** Classifier is unsure about this frame. */
      flagged: boolean;
      pinCount: number;
      selected: boolean;
      imageUrl?: string;
    };

export interface Row {
  clip: Clip;
  cells: Cell[];
}

export const pinsFor = (comments: Comment[], clip: string, frame: number): Comment[] =>
  comments.filter((c) => c.clip === clip && c.frame === frame);

export const commentsOn = (comments: Comment[], clip: string): Comment[] =>
  comments.filter((c) => c.clip === clip);

export function visibleClips(doc: Doc, ui: Ui): Clip[] {
  return doc.clips.filter(
    (c) =>
      (ui.showRejected || !c.rejected) &&
      (ui.playerFilter === ALL_PLAYERS || c.player === ui.playerFilter) &&
      (ui.strokeFilter === ALL_STROKES || c.stroke === ui.strokeFilter) &&
      // "Unchecked auto-tags only" — a clip drops out the moment a human
      // confirms or corrects anything on it.
      (!ui.lowOnly || !c.triaged) &&
      (!ui.suspectOnly || isSuspect(c)) &&
      (ui.gradeFilter === ALL_RATINGS || gradeOf(c.grade).label === ui.gradeFilter),
  );
}

/**
 * Index of the clip's anchor frame.
 *
 * A human's tag wins — that is the whole point of tagging. Failing that, and for
 * the `contact` anchor only, the ETL already knows: `offsetContactMs === 0` is
 * exactly the detector's contact frame. Every real ETL frame ships with
 * `stage: null`, so this is the path every untouched ETL swing takes.
 *
 * The midpoint is the last resort, for `setup`/`finish` (which have no ETL
 * equivalent) and for seeded clips (which have no detector). It is only ever an
 * approximation of contact: `render.py` truncates extraction at the video
 * boundaries, so a swing near either end of the source is not centred on contact
 * at all — measured off by 1 frame on swing_041 and 4 frames (~133 ms) on
 * swing_042 of a native-fps sample tree, with nothing on screen to say so. The
 * sparser a tree's stills, the further that fallback can land from contact.
 */
const anchorIndex = (clip: Clip, anchor: Phase): number => {
  const tagged = clip.frames.find((f) => f.phase === anchor);
  if (tagged !== undefined) return tagged.i;
  if (anchor === 'contact') {
    const contact = clip.frames.find((f) => f.offsetContactMs === 0);
    if (contact !== undefined) return contact.i;
  }
  return Math.floor((clip.frames.length - 1) / 2);
};

/**
 * Lays every visible clip out on one timeline, shifted so all their anchor
 * frames land in the same column. A clip whose contact is at frame 6 gets no
 * lead padding; one whose contact is at frame 3 gets three pad cells in front.
 * Columns are then labelled by their offset from the anchor (−2, −1, CONTACT,
 * +1, …), which is what makes two swings comparable at a glance.
 *
 * Each row shows at most `FRAMES_PER_CLIP` of its clip's frames, windowed around
 * that clip's anchor by `frameWindow` — the same definition `sampleFrames` uses.
 * The narrowing lives here rather than in `adaptSwing` because this is the only
 * view that needs a bounded width: 12 clips of 49 stills is a 588-tile grid
 * nobody can read — and a real session is 73 or 147 clips — while the detail
 * view wants every frame. `cell.frame` stays
 * an index into the clip's FULL frame list, so a click still selects the real
 * still.
 */
/**
 * Milliseconds between one column and the next, or null if nothing can say.
 *
 * Read off whichever clip fills the most columns, because a clip whose window
 * was cut short at an edge of its frame list is a worse witness. Seeded clips
 * carry no `offsetContactMs` at all — that is the null case, and the caller
 * falls back to counting columns.
 */
function columnStrideMs(clips: Clip[], windows: number[][]): number | null {
  let widest = -1;
  let strideMs: number | null = null;
  clips.forEach((clip, i) => {
    const window = windows[i];
    if (window.length <= 1 || window.length <= widest) return;
    const first = clip.frames[window[0]]?.offsetContactMs;
    const last = clip.frames[window[window.length - 1]]?.offsetContactMs;
    if (first === undefined || last === undefined) return;
    widest = window.length;
    strideMs = Math.round((last - first) / (window.length - 1));
  });
  return strideMs;
}

export function buildCompare(
  clips: Clip[],
  anchor: Phase,
  comments: Comment[],
  sel: { clip: string; frame: number } | null,
): { rows: Row[]; colLabels: string[] } {
  const anchors = clips.map((c) => anchorIndex(c, anchor));
  const windows = clips.map((c, i) => frameWindow(c.frames.length, anchors[i]));
  // Lead and tail are measured within the window, not the whole clip: the
  // columns either side of the anchor are the ones the grid actually renders.
  // `frameWindow` guarantees the anchor is in its window, so this never misses.
  const leads = windows.map((w, i) => Math.max(0, w.indexOf(anchors[i])));
  // Floors of 4 and FRAMES_PER_CLIP keep the grid a stable width when the
  // filters leave only one or two clips on screen.
  const maxLead = Math.max(4, ...leads);
  const maxTail = Math.max(FRAMES_PER_CLIP, ...windows.map((w, i) => w.length - leads[i]));
  const total = maxLead + maxTail;

  const rows: Row[] = clips.map((clip, i) => {
    const lead = maxLead - leads[i];
    const cells: Cell[] = [];
    for (let k = 0; k < lead; k++) cells.push({ real: false, key: `${clip.id}:lead:${k}` });
    for (const f of windows[i].map((k) => clip.frames[k])) {
      cells.push({
        real: true,
        key: `${clip.id}:${f.i}`,
        clip: clip.id,
        frame: f.i,
        num: `f${String(f.i + 1).padStart(2, '0')}`,
        phase: f.phase,
        imageUrl: f.imageUrl,
        flagged: f.conf !== undefined && f.conf < CONFIDENCE_FLOOR,
        pinCount: pinsFor(comments, clip.id, f.i).length,
        selected: sel?.clip === clip.id && sel.frame === f.i,
      });
    }
    while (cells.length < total) {
      cells.push({ real: false, key: `${clip.id}:tail:${cells.length}` });
    }
    return { clip, cells };
  });

  // Columns are a stride apart, not a frame apart, so labelling them ±1, ±2
  // would read as frames and be wrong by a factor of six. Milliseconds are what
  // the offset actually means, and they stay true whatever `--fps` the tree was
  // extracted at.
  const strideMs = columnStrideMs(clips, windows);
  const colLabels = Array.from({ length: total }, (_, k) => {
    const d = k - maxLead;
    if (d === 0) return anchor.toUpperCase();
    if (strideMs === null) return d > 0 ? `+${d}` : String(d);
    const ms = d * strideMs;
    return ms > 0 ? `+${ms}ms` : `${ms}ms`;
  });

  return { rows, colLabels };
}

/** Every player named on a clip, plus any added by hand this session. */
export const rosterOf = (doc: Doc): string[] =>
  Array.from(new Set([...doc.clips.map((c) => c.player), ...doc.extraPlayers]));

export const strokesOf = (doc: Doc): string[] =>
  Array.from(new Set(doc.clips.map((c) => c.stroke).filter((s): s is Stroke => s !== null)));

export interface Stats {
  visible: number;
  total: number;
  frames: number;
  rated: number;
  removed: number;
  /** Clips still awaiting a rating, ignoring ones already removed. */
  unrated: number;
}

export const statsOf = (doc: Doc, visible: Clip[]): Stats => ({
  visible: visible.length,
  total: doc.clips.length,
  frames: visible.reduce((n, c) => n + c.frames.length, 0),
  rated: doc.clips.filter((c) => c.grade !== null).length,
  removed: doc.clips.filter((c) => c.rejected).length,
  unrated: doc.clips.filter((c) => c.grade === null && !c.rejected).length,
});
