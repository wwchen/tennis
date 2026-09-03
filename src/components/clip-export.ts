/**
 * Downloading one swing as a video file.
 *
 * The app no longer has a file per swing to link to. It plays ONE full-length
 * `source.mp4` per session and seeks to each window, so "download this swing"
 * has no pre-rendered artefact behind it any more — the cut has to be made on
 * demand. `/api/clip` does that; everything here is the client half: the URL
 * that asks for the cut, and the name the result should be saved under.
 *
 * Pure and DOM-free on purpose. The dev-server plugin imports
 * `clipExportFileName` from here for its `Content-Disposition`, the header a browser
 * actually obeys — the anchor's `download` attribute only fills in when the
 * response carries no filename. Two implementations of one naming rule would
 * drift the moment either side changed, and the symptom would be a download
 * named nothing like what the UI promised.
 */

/**
 * A swing as `/api/clip` addresses it.
 *
 * `dir` is the swing's path under the session (`swings/swing_005`), matching the
 * `dir` field `/api/session` reports for each swing, so a caller holding an ETL
 * payload has both halves already and never has to reassemble a path.
 */
export interface ClipExportTarget {
  session: string;
  /** The swing's directory relative to the session: `swings/swing_005`. */
  dir: string;
  /** The swing's window in source-video time — `trim.source_start_ms`/`_end_ms`. */
  startMs: number;
  endMs: number;
  /**
   * Seconds of slack to add to BOTH ends, as `playWindow` adds them for
   * playback. A reviewer who widened the window to see the approach expects the
   * export to hold what they were watching, not the detector's original guess.
   */
  padS?: number;
}

/** Milliseconds, floored at zero and rounded — the route takes integers only. */
const wholeMs = (ms: number): number => Math.max(0, Math.round(ms));

/**
 * The `/api/clip` URL that cuts this swing out of the session's source video.
 *
 * Every path segment is encoded separately so that the `/` inside `dir` stays a
 * path separator while anything unusual in a session name does not become one.
 * `pad` is omitted when it is zero, which is what the route assumes in its
 * absence: a tidier URL, and one that is identical to the one the previous
 * default produced.
 */
export function clipExportUrl(target: ClipExportTarget): string {
  const path = [target.session, ...target.dir.split('/')].map(encodeURIComponent).join('/');
  const params = new URLSearchParams({
    start: String(wholeMs(target.startMs)),
    end: String(wholeMs(target.endMs)),
  });
  const pad = target.padS ?? 0;
  if (pad > 0) params.set('pad', String(pad));
  return `/api/clip/${path}?${params.toString()}`;
}

/**
 * Everything a filename may contain, as one class.
 *
 * A session name is a directory name on disk and a swing dir arrives from a URL,
 * so neither is trustworthy as a filename. Two things go wrong otherwise: a `/`
 * or `..` steers where the browser saves, and a `"` or newline breaks out of the
 * quoted `filename="..."` of the `Content-Disposition` header this same function
 * feeds. Collapsing everything else to `_` closes both.
 */
const UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * What an exported clip is called on disk.
 *
 * The session belongs in the name for the reason `clipFileName` in
 * `domain/types.ts` gives: a swing is `swing_005` in all 30 sessions under
 * `out/`, so without the prefix a reviewer's downloads folder collapses 30
 * different swings onto one name. The start time is in there too, because the
 * same swing exported at two pad settings is two different clips and the second
 * one should not silently replace the first.
 *
 * The extension is fixed rather than read off the URL — the counterpart in
 * `types.ts` had to sniff it because the ETL emitted .mp4 or .webm depending on
 * the source, whereas `/api/clip` always re-encodes to H.264 in MP4.
 */
export function clipExportFileName(target: ClipExportTarget): string {
  const padMs = Math.max(0, target.padS ?? 0) * 1000;
  // Named for where the file actually starts, not where the detector put the
  // window, so the name still describes the clip once padding has moved its head.
  const startS = Math.floor(wholeMs(target.startMs - padMs) / 1000);
  const swing = target.dir.slice(target.dir.lastIndexOf('/') + 1);
  return `${target.session.replace(UNSAFE, '_')}_${swing.replace(UNSAFE, '_')}_${startS}s.mp4`;
}
