import type { Clip } from '@/domain/types';
import type { SessionPayload, SwingEntry } from '@/domain/etl-types';
import type { SkippedSwing } from '@/domain/etl';
import { adaptSession } from '@/domain/etl';

/**
 * Reads the ETL session the dev middleware serves.
 *
 * Returns `null` for every "there is nothing to load" case — no `out/` tree, no
 * dev server, a static build, an unparseable response. The caller keeps the
 * seed, so a missing tree is a normal state rather than an error the user has to
 * see.
 *
 * A tree that EXISTS but holds documents the app cannot read is not one of those
 * cases, and used to be conflated with them: a single malformed `metadata.json`
 * threw out of `adaptSession`, was caught here, and came back as the same `null`
 * that means "no tree" — so the reviewer saw seed data instead of the 41 good
 * swings. Unreadable documents are now skipped one at a time and reported in
 * `skipped`, even when that leaves no clips at all.
 */
export async function loadEtlClips(): Promise<{
  clips: Clip[];
  entries: SwingEntry[];
  session: string;
  skipped: SkippedSwing[];
} | null> {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return null;
    const payload = (await res.json()) as SessionPayload;
    if (!Array.isArray(payload.swings) || payload.swings.length === 0) return null;
    const { clips, entries, skipped } = adaptSession(payload);
    return { clips, entries, session: payload.session, skipped };
  } catch {
    // No dev server, or a response that is not JSON. Seed stands.
    return null;
  }
}
