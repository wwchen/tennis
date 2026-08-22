import type { Clip, Frame, Phase } from './types';
import { FRAMES_PER_CLIP } from './types';

/**
 * The frame indices the compare grid shows for one clip, anchor included.
 *
 * Strided across the whole clip, not adjacent: nine adjacent stills is the
 * racket passing through the ball, nine near-identical frames, with the setup
 * and follow-through on disk but never on screen. The cost is that a column
 * offset counts strides, so `buildCompare` labels columns in milliseconds.
 *
 * Stepping outward from the anchor rather than slicing around it keeps the
 * anchor on the stride grid, and so in the shared column.
 */
export function frameWindow(
  length: number,
  anchorIndex: number,
  width: number = FRAMES_PER_CLIP,
): number[] {
  if (length <= 0 || width <= 0) return [];
  const anchor = Math.max(0, Math.min(anchorIndex, length - 1));
  const span = Math.min(width, length);
  if (span === 1) return [anchor];

  const stride = Math.max(1, Math.floor((length - 1) / (span - 1)));
  const lead = Math.floor((span - 1) / 2);

  // How far the anchor can actually reach in each direction, in strides.
  const maxBack = Math.floor(anchor / stride);
  const maxFwd = Math.floor((length - 1 - anchor) / stride);

  // Centre on the anchor, then hand whatever one side cannot use to the other,
  // so a swing whose contact sits near an edge still fills its row.
  let back = Math.min(lead, maxBack);
  const fwd = Math.min(span - 1 - back, maxFwd);
  back = Math.min(maxBack, span - 1 - fwd);

  const indices: number[] = [];
  for (let k = -back; k <= fwd; k++) indices.push(anchor + k * stride);
  return indices;
}

/**
 * The still that represents one phase of a clip.
 *
 * A human tag wins. Otherwise: contact is the ETL's own `offsetContactMs === 0`,
 * and setup/finish are the ends of the extracted span. Every ETL frame ships
 * `stage: null`, so untouched clips always take the fallback.
 */
export function phaseFrame(clip: Clip, phase: Phase): Frame | undefined {
  const tagged = clip.frames.find((f) => f.phase === phase);
  if (tagged !== undefined) return tagged;
  if (clip.frames.length === 0) return undefined;
  if (phase === 'setup') return clip.frames[0];
  if (phase === 'finish') return clip.frames[clip.frames.length - 1];
  return (
    clip.frames.find((f) => f.offsetContactMs === 0) ??
    clip.frames[Math.floor((clip.frames.length - 1) / 2)]
  );
}
