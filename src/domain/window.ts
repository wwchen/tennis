import { FRAMES_PER_CLIP } from './types';

/** A half-open slice `[start, end)` of a frame list. */
export interface Window {
  start: number;
  end: number;
}

/**
 * The one definition of "the frames shown around an anchor".
 *
 * A `Clip` carries every still the ETL extracted (42-49 on real footage); the
 * compare grid can only lay a fixed number of columns on a shared timeline, so
 * it shows a contiguous run of `width` frames containing the anchor. The run is
 * centred on the anchor and shifted inward at either end, so it is always
 * exactly `min(width, length)` frames rather than a short window on the clips
 * whose anchor sits near an edge.
 *
 * Contiguous and index-based on purpose: the grid's columns are labelled by
 * offset from the anchor, which is only meaningful if neighbouring cells are
 * neighbouring stills.
 */
export function frameWindow(
  length: number,
  anchorIndex: number,
  width: number = FRAMES_PER_CLIP,
): Window {
  const span = Math.min(width, length);
  if (span <= 0) return { start: 0, end: 0 };
  const lead = Math.floor((span - 1) / 2);
  const start = Math.max(0, Math.min(anchorIndex - lead, length - span));
  return { start, end: start + span };
}
