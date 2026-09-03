import type { Clip } from '@/domain/types';
import type { EtlProxy, EtlSource, SessionPayload, SwingEntry } from '@/domain/etl-types';
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
export async function loadEtlClips(requested?: string): Promise<{
  clips: Clip[];
  entries: SwingEntry[];
  session: string;
  sessions: string[];
  playable: string[];
  source: EtlSource | null;
  proxy: EtlProxy | null;
  settings: Record<string, unknown> | null;
  detection: Record<string, unknown> | null;
  skipped: SkippedSwing[];
} | null> {
  try {
    // A requested session the tree does not have 404s, which lands on the
    // `!res.ok` line below and keeps whatever is already loaded.
    const query = requested === undefined ? '' : `?session=${encodeURIComponent(requested)}`;
    const res = await fetch(`/api/session${query}`);
    if (!res.ok) return null;
    const payload = (await res.json()) as SessionPayload;
    if (!Array.isArray(payload.swings) || payload.swings.length === 0) return null;
    const { clips, entries, skipped } = adaptSession(payload);
    // Guarded like `swings` above, and for the same reason: this is a parsed
    // network response, not a value the type system has actually checked.
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [payload.session];
    return {
      clips,
      entries,
      session: payload.session,
      sessions,
      // Guarded like `sessions`: a dev server predating this key sends none.
      playable: Array.isArray(payload.playable) ? payload.playable : sessions,
      source: payload.source ?? null,
      // `?? null` rather than trusting the type: this is a parsed network
      // response, and every tree written before proxies existed omits the key.
      proxy: payload.proxy ?? null,
      settings: payload.settings ?? null,
      detection: payload.detection ?? null,
      skipped,
    };
  } catch {
    // No dev server, or a response that is not JSON. Seed stands.
    return null;
  }
}
