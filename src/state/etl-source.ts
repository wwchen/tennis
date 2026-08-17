import type { Clip } from '@/domain/types';
import type { SessionPayload, SwingEntry } from '@/domain/etl-types';
import { adaptSession } from '@/domain/etl';

/**
 * Reads the ETL session the dev middleware serves.
 *
 * Returns `null` for every "there is nothing to load" case — no `out/` tree, no
 * dev server, a static build, a malformed response. The caller keeps the seed,
 * so a missing tree is a normal state rather than an error the user has to see.
 */
export async function loadEtlClips(): Promise<{
  clips: Clip[];
  entries: SwingEntry[];
  session: string;
} | null> {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return null;
    const payload = (await res.json()) as SessionPayload;
    if (!Array.isArray(payload.swings) || payload.swings.length === 0) return null;
    return {
      clips: adaptSession(payload),
      entries: payload.swings,
      session: payload.session,
    };
  } catch {
    // No dev server, malformed payload, or corrupt metadata. Seed stands.
    return null;
  }
}
