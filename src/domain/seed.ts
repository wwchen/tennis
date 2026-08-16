import type { Clip, Comment, Frame, Stroke } from './types';
import { FRAMES_PER_CLIP } from './types';

/** [id, player, stroke, confidence, setupFrame, contactFrame, finishFrame] */
type ClipDef = [string, string, Stroke, number, number, number, number];

const CLIP_DEFS: ClipDef[] = [
  ['SL-001', 'Me', 'Forehand', 0.94, 1, 4, 7],
  ['SL-002', 'Me', 'Forehand', 0.61, 1, 5, 8],
  ['SL-004', 'Me', 'Backhand', 0.88, 0, 3, 6],
  ['SL-007', 'Coach Ana', 'Forehand', 0.97, 1, 4, 7],
  ['SL-009', 'Me', 'Serve', 0.72, 2, 6, 8],
  ['SL-011', 'Me', 'Forehand', 0.44, 2, 3, 5],
  ['SL-012', 'Pro reference', 'Forehand', 0.99, 1, 4, 8],
  ['SL-014', 'Me', 'Backhand', 0.81, 1, 5, 7],
  ['SL-016', 'Coach Ana', 'Serve', 0.91, 2, 5, 8],
  ['SL-018', 'Me', 'Volley', 0.58, 0, 2, 4],
  ['SL-021', 'Me', 'Forehand', 0.86, 2, 5, 7],
  ['SL-023', 'Pro reference', 'Backhand', 0.95, 1, 4, 7],
];

/**
 * Per-frame confidence wobbles deterministically around the clip's own score,
 * so the same clip always flags the same frames across reloads and test runs.
 */
const frameConf = (clipConf: number, i: number) =>
  Math.max(0.3, Math.min(0.99, clipConf + (((i * 7) % 5) - 2) * 0.05));

const buildFrames = (conf: number, setup: number, contact: number, finish: number): Frame[] =>
  Array.from({ length: FRAMES_PER_CLIP }, (_, i) => ({
    i,
    phase: i === setup ? 'setup' : i === contact ? 'contact' : i === finish ? 'finish' : null,
    conf: frameConf(conf, i),
  }));

export const seedClips = (): Clip[] =>
  CLIP_DEFS.map(([id, player, stroke, conf, setup, contact, finish]) => ({
    id,
    player,
    stroke,
    conf,
    rejected: id === 'SL-011',
    duration: `0:0${2 + (setup % 3)}`,
    triaged: id === 'SL-002' || id === 'SL-012',
    grade: null,
    note:
      id === 'SL-002'
        ? 'Contact drifts behind the hip on the run. Set up a step earlier.'
        : '',
    frames: buildFrames(conf, setup, contact, finish),
  }));

export const seedComments = (): Comment[] => [
  {
    id: 1,
    clip: 'SL-002',
    frame: 5,
    author: 'Coach Ana',
    at: '2d',
    text: 'Contact is a full frame late here — racket face still closing.',
  },
  { id: 2, clip: 'SL-002', frame: 5, author: 'Me', at: '1d', text: 'Agreed. Reclassified from frame 6.' },
  {
    id: 3,
    clip: 'SL-009',
    frame: 2,
    author: 'Coach Ana',
    at: '4d',
    text: 'Toss drifts behind the head. Compare against SL-016.',
  },
  {
    id: 4,
    clip: 'SL-012',
    frame: 4,
    author: 'Me',
    at: '6d',
    text: 'Reference contact point. Use this as the baseline.',
  },
];

/** First id `postComment` may hand out — one past the seeded comments. */
export const SEED_NEXT_COMMENT_ID = 5;

/** The clip seeded as already removed, pre-loaded into the undo stack. */
export const SEED_REMOVED_STACK = ['SL-011'];
