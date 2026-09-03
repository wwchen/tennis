import { describe, expect, it } from 'vitest';
import { clipExportFileName, clipExportUrl } from './clip-export';

const SWING = { session: 'IMG_0684', dir: 'swings/swing_005', startMs: 24506, endMs: 28006 };

describe('clipExportUrl', () => {
  it('addresses the swing by session and directory, with the window as a query', () => {
    expect(clipExportUrl(SWING)).toBe('/api/clip/IMG_0684/swings/swing_005?start=24506&end=28006');
  });

  it('omits pad when there is none, which is what the route assumes', () => {
    expect(clipExportUrl({ ...SWING, padS: 0 })).not.toContain('pad');
  });

  it('carries a fractional pad through — the UI offers 0.5s', () => {
    expect(clipExportUrl({ ...SWING, padS: 0.5 })).toBe(
      '/api/clip/IMG_0684/swings/swing_005?start=24506&end=28006&pad=0.5',
    );
  });

  it('sends whole milliseconds: the route parses integers and decimals alike, but a swing has no sub-millisecond boundary', () => {
    expect(clipExportUrl({ ...SWING, startMs: 24506.4, endMs: 28005.6 })).toContain(
      'start=24506&end=28006',
    );
  });

  it('never emits a negative start', () => {
    // A swing at the head of the video with the window arithmetic already
    // applied upstream: `?start=-500` would be refused by the route, so the
    // clamp belongs here rather than showing up as a 400 the reviewer sees.
    expect(clipExportUrl({ ...SWING, startMs: -500 })).toContain('start=0');
  });

  it('keeps the slash inside dir a path separator while escaping everything else', () => {
    // `encodeURIComponent` on the whole path would send `swings%2Fswing_005`,
    // which no longer matches the route's `<session>/swings/swing_NNN` shape.
    const url = clipExportUrl({ ...SWING, session: 'a b&c' });
    expect(url).toBe('/api/clip/a%20b%26c/swings/swing_005?start=24506&end=28006');
  });
});

describe('clipExportFileName', () => {
  it('puts the session in the name', () => {
    // The whole point: `swing_005` exists in every session under `out/`, so
    // without the prefix a reviewer's downloads folder collapses 30 different
    // swings onto one filename.
    expect(clipExportFileName(SWING)).toBe('IMG_0684_swing_005_24s.mp4');
  });

  it('gives the same swing number in two sessions two different names', () => {
    expect(clipExportFileName({ ...SWING, session: 'IMG_0685' })).not.toBe(
      clipExportFileName(SWING),
    );
  });

  it('names the file for where it actually starts, so two pads do not collide', () => {
    // The same swing exported at pad 0 and pad 4 is two different clips; the
    // second must not silently overwrite the first in the downloads folder.
    expect(clipExportFileName({ ...SWING, padS: 4 })).toBe('IMG_0684_swing_005_20s.mp4');
    expect(clipExportFileName({ ...SWING, padS: 4 })).not.toBe(clipExportFileName(SWING));
  });

  it('floors a pad that would reach before the start of the video', () => {
    expect(clipExportFileName({ ...SWING, startMs: 800, padS: 4 })).toBe(
      'IMG_0684_swing_005_0s.mp4',
    );
  });

  it('always says .mp4 — the route re-encodes to H.264 whatever the source was', () => {
    expect(clipExportFileName(SWING).endsWith('.mp4')).toBe(true);
  });

  it('collapses anything that is not a plain filename character', () => {
    // A session is a directory name on disk. A quote in one would otherwise
    // close the `filename="..."` of the Content-Disposition header the route
    // builds from this, and a slash would steer where the browser saves.
    expect(clipExportFileName({ ...SWING, session: 'a"b/c\nd' })).toBe(
      'a_b_c_d_swing_005_24s.mp4',
    );
    // A `..` survives, because a dot is a legal filename character; what does
    // not survive is the separator between them, and without one there is no
    // traversal left to perform.
    expect(clipExportFileName({ ...SWING, session: '../..' })).toBe('.._.._swing_005_24s.mp4');
  });
});
