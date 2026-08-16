import type { Clip, Comment } from '@/domain/types';

const KEY = 'shot-lab.doc';

/**
 * Bump when the shape below changes incompatibly. A stored doc carrying any
 * other version is discarded rather than migrated: this is coaching scratch
 * data seeded from a fixture, so a fresh seed costs nothing and a half-migrated
 * doc would be worse than none.
 */
const VERSION = 1;

/** The slice of state that survives a reload. UI state deliberately does not. */
export interface Doc {
  clips: Clip[];
  comments: Comment[];
  extraPlayers: string[];
  removedStack: string[];
  nextCommentId: number;
}

interface StoredDoc extends Doc {
  v: number;
}

const isDoc = (value: unknown): value is StoredDoc => {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<StoredDoc>;
  return (
    d.v === VERSION &&
    Array.isArray(d.clips) &&
    Array.isArray(d.comments) &&
    Array.isArray(d.extraPlayers) &&
    Array.isArray(d.removedStack) &&
    typeof d.nextCommentId === 'number'
  );
};

export const loadDoc = (): Doc | null => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Private-mode Safari and blocked third-party storage both throw on access
    // rather than returning null. Losing persistence is not worth a blank app.
    return null;
  }
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isDoc(parsed)) return null;
    // Rebuilt field by field rather than spread-minus-`v`: whatever else a
    // stored blob happens to carry stays out of the live document.
    return {
      clips: parsed.clips,
      comments: parsed.comments,
      extraPlayers: parsed.extraPlayers,
      removedStack: parsed.removedStack,
      nextCommentId: parsed.nextCommentId,
    };
  } catch {
    return null;
  }
};

export const saveDoc = (doc: Doc): void => {
  try {
    const stored: StoredDoc = { v: VERSION, ...doc };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Quota exhausted or storage blocked. The session keeps working in memory.
  }
};

export const clearDoc = (): void => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do — see loadDoc.
  }
};
