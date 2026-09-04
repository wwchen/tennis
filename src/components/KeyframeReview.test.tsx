import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyframeReview } from './KeyframeReview';
import type { BallCandidatesDoc } from './ball-labels';

/**
 * The labelling pass, end to end through the component.
 *
 * jsdom decodes nothing — every dimension reads zero and `currentTime` never
 * advances — so the boxes and the crosshair cannot be asserted here; that
 * arithmetic is covered in `ball-labels.test.ts`, where it is pure. What this
 * pins is the part that only exists once the component is wired up: which keys
 * do what, and what actually gets written to disk.
 */

const CANDIDATES: BallCandidatesDoc = {
  header: {
    detector: 'yolo/coco',
    weights: 'yolo11x.pt',
    // Native rate and windowed, which is what `0` means in this file.
    fps: 0,
    conf: 0.1,
    width: 1080,
    height: 1920,
    windows: [{ startMs: 79733, endMs: 79766, contactMs: 79750 }],
  },
  frames: [
    { ms: 79733, ball: [[833, 972, 20, 20, 0.44]] },
    { ms: 79750 },
    { ms: 79766, ball: [[891, 967, 20, 20, 0.3]] },
  ],
};

/** Every PUT body the component sent, newest last. */
let written: string[] = [];

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;

beforeEach(() => {
  written = [];
  // jsdom implements neither, and `goto` calls `play().catch(...)` on a value
  // that would otherwise not be a promise.
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/ball-candidates/')) return Promise.resolve(jsonResponse(CANDIDATES));
      if (url.startsWith('/api/ball-labels/')) {
        if (init?.method === 'PUT') {
          // Always a JSON string here: the component serialises before sending.
          written.push(init.body as string);
          return Promise.resolve({ ok: true, status: 204 } as Response);
        }
        // No labels on disk yet, which is where every session starts.
        return Promise.resolve(jsonResponse(null, 404));
      }
      return Promise.resolve(jsonResponse(null, 404));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderView = () =>
  render(
    <KeyframeReview
      clips={[]}
      proxyUrl="/api/media/IMG_0684/source.mp4"
      durationMs={500_000}
      session="IMG_0684"
      sessions={['IMG_0684']}
      onSession={() => undefined}
    />,
  );

/** The document of the last PUT, parsed. */
const lastWritten = (): { session: string; labels: Record<string, unknown> } =>
  JSON.parse(written[written.length - 1]) as { session: string; labels: Record<string, unknown> };

describe('KeyframeReview ball labelling', () => {
  it('offers labelling only for a session the candidate pass has been run over', async () => {
    // The button is the only thing that says the mode exists, so it must not
    // appear where there is nothing to confirm.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(null, 404))));
    renderView();

    await waitFor(() => expect(screen.getByText(/0 swings/)).toBeInTheDocument());
    expect(screen.queryByText('Label ball (b)')).not.toBeInTheDocument();
  });

  it('writes a verdict per frame, keyed by source timestamp', async () => {
    renderView();
    await screen.findByText('Label ball (b)');

    fireEvent.keyDown(window, { key: 'b' });
    // `a` takes the offered candidate's CENTRE and advances; `n` records "a
    // human looked and there is no ball", which is a label rather than a gap.
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'n' });

    await waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 2000 });
    const doc = lastWritten();

    // The keys are the frames' own timestamps. NOT swing ids: re-running
    // detection renumbers every `swings/swing_NNN`, and anything keyed to those
    // numbers is orphaned the moment it does.
    expect(doc.labels['79733']).toEqual([843, 982]);
    expect(doc.labels).toHaveProperty('79750');
    expect(doc.labels['79750']).toBeNull();
    expect(doc.session).toBe('IMG_0684');
    expect(Object.keys(doc.labels).every((k) => /^\d+$/.test(k))).toBe(true);
  });

  it('counts a frame nobody has looked at as remaining, and a "no ball" as done', async () => {
    renderView();
    await screen.findByText('Label ball (b)');

    // `getAllBy`: the count is shown twice on purpose — over the stage, where
    // the eyes are, and in the transport row beside the button that turned the
    // mode on.
    fireEvent.keyDown(window, { key: 'b' });
    expect(screen.getAllByText(/0\/3/).length).toBeGreaterThan(0);

    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.getAllByText(/1\/3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 left/).length).toBeGreaterThan(0);
  });

  it('takes a label back without turning it into a "no ball"', async () => {
    renderView();
    await screen.findByText('Label ball (b)');

    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(Object.keys(lastWritten().labels)).toEqual(['79733']);

    // Back onto the labelled frame, then unlabel it: the key goes away
    // entirely, because "nobody has looked" is what an absent key means.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'Backspace' });
    await waitFor(() => expect(Object.keys(lastWritten().labels)).toEqual([]), { timeout: 2000 });
  });

  it('rebinds the arrows to frames only while labelling', async () => {
    renderView();
    await screen.findByText('Label ball (b)');

    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 2000 });

    // The second frame of the file, reached by stepping one frame — not the
    // second swing, which is what the same key means outside the mode.
    expect(Object.keys(lastWritten().labels)).toEqual(['79750']);
  });

  it('never writes before it has read what is already on disk', async () => {
    // The gate that keeps a session switch from replacing somebody else's
    // ground truth with an empty document.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/ball-candidates/')) return Promise.resolve(jsonResponse(CANDIDATES));
        if (url.startsWith('/api/ball-labels/')) {
          if (init?.method === 'PUT') {
            written.push(init.body as string);
            return Promise.resolve({ ok: true, status: 204 } as Response);
          }
          // 409: a file exists that this build cannot parse.
          return Promise.resolve(jsonResponse(null, 409));
        }
        return Promise.resolve(jsonResponse(null, 404));
      }),
    );
    renderView();
    await screen.findByText('ball labels unreadable');

    fireEvent.keyDown(window, { key: 'b' });
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.keyDown(window, { key: 'n' });

    await new Promise((r) => setTimeout(r, 700));
    expect(written).toEqual([]);
  });
});
