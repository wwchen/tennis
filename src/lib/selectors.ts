import type { Clip, Comment, Phase, Stroke } from '@/domain/types';
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
      (ui.gradeFilter === ALL_RATINGS || gradeOf(c.grade).label === ui.gradeFilter),
  );
}

/**
 * Index of the clip's anchor frame, or the middle of the extraction when it
 * carries no tag.
 *
 * The midpoint rather than a constant: a `Clip` carries every extracted frame
 * (42-49 on real footage), and the ETL centres its extraction on contact, so the
 * middle of an untagged clip is the best guess at the same moment the tagged
 * clips are aligned on. A fixed 4 would have pinned every untagged real clip to
 * its 5th still, ~750 ms before contact.
 */
const anchorIndex = (clip: Clip, anchor: Phase): number =>
  clip.frames.find((f) => f.phase === anchor)?.i ?? Math.floor((clip.frames.length - 1) / 2);

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
 * nobody can read, while the detail view wants every frame. `cell.frame` stays
 * an index into the clip's FULL frame list, so a click still selects the real
 * still.
 */
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
  const leads = anchors.map((a, i) => a - windows[i].start);
  // Floors of 4 and FRAMES_PER_CLIP keep the grid a stable width when the
  // filters leave only one or two clips on screen.
  const maxLead = Math.max(4, ...leads);
  const maxTail = Math.max(
    FRAMES_PER_CLIP,
    ...clips.map((_, i) => windows[i].end - anchors[i]),
  );
  const total = maxLead + maxTail;

  const rows: Row[] = clips.map((clip, i) => {
    const lead = maxLead - leads[i];
    const cells: Cell[] = [];
    for (let k = 0; k < lead; k++) cells.push({ real: false, key: `${clip.id}:lead:${k}` });
    for (const f of clip.frames.slice(windows[i].start, windows[i].end)) {
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

  const colLabels = Array.from({ length: total }, (_, k) => {
    const d = k - maxLead;
    if (d === 0) return anchor.toUpperCase();
    return d > 0 ? `+${d}` : String(d);
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
