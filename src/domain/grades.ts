import type { Hue } from '@lew-ds/lds/templates';
import type { Clip, Grade, Phase } from './types';

/** `none` is the pseudo-grade an unrated clip reports, so lookups never miss. */
export const GRADES: Record<Grade | 'none', { label: string; hue: Hue }> = {
  good: { label: 'Good', hue: 'green' },
  ok: { label: 'OK', hue: 'yellow' },
  work: { label: 'Needs work', hue: 'red' },
  none: { label: 'Unrated', hue: 'gray' },
};

/** Order the three rating chips appear in, everywhere they appear. */
export const GRADE_ORDER: Grade[] = ['good', 'ok', 'work'];

export const gradeOf = (grade: Grade | null) => GRADES[grade ?? 'none'];

const STROKE_HUES: Record<string, Hue> = {
  Forehand: 'green',
  Backhand: 'blue',
  Serve: 'violet',
  Volley: 'pink',
  Overhead: 'orange',
  Other: 'gray',
};

export const strokeHue = (stroke: string | null): Hue =>
  stroke === null ? 'gray' : STROKE_HUES[stroke] ?? 'gray';

/** Badge colour for each phase, matching the palette tokens the tiles use. */
export const PHASE_BADGE: Record<Phase, string> = {
  setup: 'var(--cyan-300)',
  contact: 'var(--orange-300)',
  finish: 'var(--violet-300)',
};

export const PHASES: Phase[] = ['setup', 'contact', 'finish'];

/**
 * How a clip's tags should be described: everything starts auto-tagged by the
 * classifier and becomes "checked" the moment a human touches any of it.
 */
export const autoMeta = (clip: Clip): { label: string; title: string } =>
  clip.triaged
    ? { label: 'checked', title: 'Frame tags confirmed or corrected by hand' }
    : { label: 'auto-tagged', title: 'Frames auto-tagged by the classifier, not yet checked' };
