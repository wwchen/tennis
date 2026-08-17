import type { Clip, Comment, Phase, Stroke } from '@/domain/types';
import {
  ALL_PLAYERS,
  ALL_RATINGS,
  ALL_STROKES,
  CONFIDENCE_FLOOR,
  FRAMES_PER_CLIP,
} from '@/domain/types';
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
      frame: number;
      /** Frame label, `f01`…`f09`. */
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

/** Index of the clip's anchor frame, or the midpoint when it carries no tag. */
const anchorIndex = (clip: Clip, anchor: Phase): number =>
  clip.frames.find((f) => f.phase === anchor)?.i ?? 4;

/**
 * Lays every visible clip out on one timeline, shifted so all their anchor
 * frames land in the same column. A clip whose contact is at frame 6 gets no
 * lead padding; one whose contact is at frame 3 gets three pad cells in front.
 * Columns are then labelled by their offset from the anchor (−2, −1, CONTACT,
 * +1, …), which is what makes two swings comparable at a glance.
 */
export function buildCompare(
  clips: Clip[],
  anchor: Phase,
  comments: Comment[],
  sel: { clip: string; frame: number } | null,
): { rows: Row[]; colLabels: string[] } {
  const anchors = clips.map((c) => anchorIndex(c, anchor));
  // Floors of 4 and FRAMES_PER_CLIP keep the grid a stable width when the
  // filters leave only one or two clips on screen.
  const maxLead = Math.max(4, ...anchors);
  const maxTail = Math.max(FRAMES_PER_CLIP, ...clips.map((c, i) => c.frames.length - anchors[i]));
  const total = maxLead + maxTail;

  const rows: Row[] = clips.map((clip, i) => {
    const lead = maxLead - anchors[i];
    const cells: Cell[] = [];
    for (let k = 0; k < lead; k++) cells.push({ real: false, key: `${clip.id}:lead:${k}` });
    for (const f of clip.frames) {
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
