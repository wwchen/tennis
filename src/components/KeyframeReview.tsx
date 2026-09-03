import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Clip } from '@/domain/types';
import { shortId } from '@/domain/types';
import { Button, ICONS, Select, Toggle, checkedOf, valueOf } from '@/lds';
import {
  PAD_STEPS,
  clock,
  nearestSwing,
  playWindow,
  timelinePercent,
  windowProgress,
  windowsFor,
} from './source-playback';

/**
 * Review a session by seeking the SOURCE video, not by playing cut clips.
 *
 * One `<video>` holds the whole session for the life of the view, and picking a
 * swing seeks it. That is the entire design: the element is never re-`src`-ed,
 * because a swing is a pair of timestamps rather than a file, so the frames on
 * either side of a badly-detected window are always already loaded. Measured on
 * IMG_0684 (108 swings, 8:21, 730MB) a seek lands in 9-24ms.
 *
 * The end of a window therefore PAUSES rather than ending anything: "Keep
 * playing" runs straight past it into the rest of the video, and the pad control
 * widens every window at once. Both exist for one reason — the detector's
 * boundaries are the thing under review, so the UI must never be why a reviewer
 * cannot see past them.
 */

/** How long the end-of-window card counts down before advancing, in ms. */
const HOLD_MS = 4000;

/** The slow-motion replay rate. */
const SLOW_RATE = 0.35;

interface Props {
  clips: Clip[];
  /** `/api/media/<session>/source.mp4`, or undefined when there is no proxy. */
  proxyUrl?: string;
  /** Source length in ms, for the timeline. */
  durationMs: number;
  session: string;
  sessions: string[];
  onSession: (session: string) => void;
  /**
   * Told which swing is showing, so the rest of the app can follow along.
   *
   * Must NOT navigate. This view owns the whole window and its own selection;
   * wiring this to `openDetail` switched to the detail view on every arrow
   * key, which made the keyframe review impossible to actually use.
   */
  onSelect?: (id: string) => void;
}

export function KeyframeReview({
  clips,
  proxyUrl,
  durationMs,
  session,
  sessions,
  onSession,
  onSelect,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const rail = useRef<HTMLDivElement>(null);

  const windows = useMemo(() => windowsFor(clips), [clips]);
  const [idx, setIdx] = useState(0);
  const [padS, setPadS] = useState<number>(0);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [cursorMs, setCursorMs] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [held, setHeld] = useState(false);
  /** Set by "Keep playing": drops the window bound until the next selection. */
  const [unbounded, setUnbounded] = useState(false);

  const current = windows[idx];
  const bounds = useMemo(
    () => (current === undefined ? null : playWindow(current, durationMs, padS)),
    [current, durationMs, padS],
  );

  // The boundary is read through a ref so the two watchers below never have to
  // re-subscribe to see a new window — re-attaching a `timeupdate` listener on
  // every pad change would drop events mid-swing.
  const boundary = useRef<{ endMs: number; unbounded: boolean }>({
    endMs: Infinity,
    unbounded: false,
  });
  useEffect(() => {
    boundary.current = { endMs: bounds?.endMs ?? Infinity, unbounded };
  }, [bounds, unbounded]);

  const stopAtWindowEnd = useCallback(() => {
    const el = video.current;
    if (el === null || el.paused) return;
    const { endMs, unbounded: free } = boundary.current;
    if (free || el.currentTime * 1000 < endMs) return;
    el.pause();
    setAtEnd(true);
    setCountdown(HOLD_MS);
  }, []);

  // TWO watchers, because neither alone is correct.
  //
  // `requestAnimationFrame` gives frame-accurate stops while the tab is
  // visible, which a timer cannot: at 0.35x a 40ms tick overshoots by several
  // frames, the difference between stopping on contact and after it.
  //
  // But rAF does not run at all in a hidden tab — measured here, a backgrounded
  // pane fired zero frames in a second — so on its own it let a swing play
  // straight through its window and on into the rest of the session. Media
  // events keep firing when hidden, so `timeupdate` is the backstop that makes
  // the boundary hold regardless of whether anyone is looking at it.
  useEffect(() => {
    const el = video.current;
    if (el === null) return;
    const onTimeUpdate = () => {
      setCursorMs(el.currentTime * 1000);
      stopAtWindowEnd();
    };
    el.addEventListener('timeupdate', onTimeUpdate);
    return () => el.removeEventListener('timeupdate', onTimeUpdate);
  }, [stopAtWindowEnd]);

  useEffect(() => {
    const el = video.current;
    if (el === null) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setCursorMs(el.currentTime * 1000);
      stopAtWindowEnd();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stopAtWindowEnd]);

  /** Seek to a window and play it. The only path that moves the selection. */
  const goto = useCallback(
    (next: number, playRate = 1) => {
      const clamped = Math.max(0, Math.min(windows.length - 1, next));
      const target = windows[clamped];
      if (target === undefined) return;
      const { startMs } = playWindow(target, durationMs, padS);
      setIdx(clamped);
      setAtEnd(false);
      setCountdown(0);
      setHeld(false);
      setUnbounded(false);
      setRate(playRate);
      onSelect?.(target.id);

      const el = video.current;
      if (el === null) return;
      el.playbackRate = playRate;
      el.currentTime = startMs / 1000;
      // Autoplay can be refused before the page has been interacted with. The
      // seek still landed, so the right frame is on screen, merely paused.
      void el.play().catch(() => undefined);
    },
    [windows, durationMs, padS, onSelect],
  );

  /** Replay the current window, optionally slowed. */
  const replay = useCallback((playRate: number) => goto(idx, playRate), [goto, idx]);

  const toggle = useCallback(() => {
    const el = video.current;
    if (el === null) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    // Resuming at the end of a window replays it; resuming from a pause in the
    // middle of one simply continues.
    if (atEnd) {
      replay(1);
      return;
    }
    void el.play().catch(() => undefined);
  }, [atEnd, replay]);

  /** Run on past the window end, into the rest of the video. */
  const keepPlaying = useCallback(() => {
    const el = video.current;
    if (el === null) return;
    setUnbounded(true);
    setAtEnd(false);
    setCountdown(0);
    void el.play().catch(() => undefined);
  }, []);

  // Auto-advance, once the end card has counted down. Held while the pointer is
  // over the card, so reading it does not cost the swing.
  useEffect(() => {
    if (!atEnd || !autoAdvance || held) return;
    if (idx >= windows.length - 1) return;
    const timer = setTimeout(() => {
      // Both the countdown and the advance happen on the timer: advancing from
      // the effect body instead makes selecting a swing a render-time side
      // effect, which cascades renders and trips react-hooks/set-state-in-effect.
      if (countdown <= 0) goto(idx + 1);
      else setCountdown((c) => c - 100);
    }, 100);
    return () => clearTimeout(timer);
  }, [atEnd, autoAdvance, held, countdown, idx, windows.length, goto]);

  // Keyboard, as the design specifies: arrows step, space pauses, r restarts,
  // s slows. Ignored while a field has focus, so typing a note is not transport.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goto(idx + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goto(idx - 1);
      } else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'r' || e.key === 'R') {
        replay(1);
      } else if (e.key === 's' || e.key === 'S') {
        replay(SLOW_RATE);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goto, idx, toggle, replay]);

  // Keep the selected row in view without yanking the rail on every frame.
  useEffect(() => {
    const row = rail.current?.children[idx] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  // Re-seek when the pad changes under a paused swing, so what is on screen is
  // the new window's start rather than a frame from the old one.
  useEffect(() => {
    const el = video.current;
    if (el === null || bounds === null || !el.paused) return;
    if (el.currentTime * 1000 < bounds.startMs) el.currentTime = bounds.startMs / 1000;
  }, [bounds]);

  const header = (
    <header style={S.header}>
      <span style={S.brand}>Keyframes</span>
      <div style={S.headerGroup}>
        <span style={S.label}>Video</span>
        <span style={{ width: 250 }}>
          <Select
            size="sm"
            aria-label="Source video"
            value={session}
            onChange={(e: Event) => onSession(valueOf(e))}
            options={sessions}
          />
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <span style={S.mono}>{clock(durationMs)} source</span>
    </header>
  );

  // The header stays: it holds the source picker, and without it a session
  // with no proxy is a dead end the reviewer cannot navigate out of.
  if (proxyUrl === undefined) {
    return (
      <div style={S.root}>
        {header}
        <div style={S.empty}>
          <span style={S.emptyTitle}>No source video for {session}</span>
          <span style={S.emptyBody}>
            Its source video is not in <code>raw/</code>, so there is nothing to build a
            playable copy from. The swings and their stills are all still here — Catalog and
            Compare work as before. To review it here, put the source back and run{' '}
            <code>tennisproc proxy out/{session}</code>, which transcodes the video and
            nothing else. Do not re-run the full pipeline: that re-detects, renumbers every
            swing, and orphans the verdicts already recorded against them.
          </span>
        </div>
      </div>
    );
  }

  const windowFill = bounds === null ? 0 : windowProgress(cursorMs, bounds.startMs, bounds.endMs);
  const counter = `${windows.length === 0 ? 0 : idx + 1} / ${windows.length}`;

  return (
    <div style={S.root}>
      {header}

      <div style={S.body}>
        <main style={S.main}>
          <div style={S.stageWrap}>
            <div style={S.stage}>
              <video
                ref={video}
                // Deliberately NOT keyed on the swing: re-mounting the element
                // per swing is what the clip-per-file design did, and it throws
                // away the buffer that makes a 9ms seek possible.
                src={proxyUrl}
                playsInline
                style={S.video}
                onClick={toggle}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />

              <div style={S.badgeRow}>
                <span style={S.badge}>{current === undefined ? '—' : shortId(current.id)}</span>
                <span style={S.badgeDim}>
                  {bounds === null
                    ? '—'
                    : `${clock(bounds.startMs, true)} → ${clock(bounds.endMs, true)}`}
                </span>
              </div>

              <div style={S.badgeRight}>
                {unbounded && <span style={S.badgeDim}>past window</span>}
                <span style={S.badgeDim}>{rate === 1 ? '1×' : `${rate}×`}</span>
                <span style={S.badgeDim}>{clock(cursorMs, true)}</span>
              </div>

              {!playing && !atEnd && (
                <div style={S.pausedWrap} onClick={toggle}>
                  <div style={S.pausedPill}>Paused</div>
                </div>
              )}

              <div style={S.windowTrack}>
                <div style={{ ...S.windowFill, width: `${(windowFill * 100).toFixed(1)}%` }} />
              </div>

              {atEnd && (
                <div style={S.endScrim}>
                  <div
                    style={S.endCard}
                    onMouseEnter={() => setHeld(true)}
                    onMouseLeave={() => {
                      setHeld(false);
                      setCountdown(HOLD_MS);
                    }}
                  >
                    <div style={S.endBar}>
                      <div
                        style={{
                          ...S.endBarFill,
                          width:
                            autoAdvance && idx < windows.length - 1
                              ? `${(100 - (Math.max(0, countdown) / HOLD_MS) * 100).toFixed(1)}%`
                              : '0%',
                        }}
                      />
                    </div>
                    <div style={S.endBody}>
                      <div style={S.endHead}>
                        <span style={S.endTitle}>
                          {current === undefined ? '—' : shortId(current.id)}
                        </span>
                        <span style={S.label}>
                          {!autoAdvance || idx >= windows.length - 1
                            ? 'End of window'
                            : held
                              ? 'Countdown held'
                              : `Next in ${Math.max(0, countdown / 1000).toFixed(1)}s`}
                        </span>
                      </div>
                      <div style={S.endRow}>
                        <span onClick={() => replay(1)} style={S.click}>
                          <Button variant="primary" size="sm" iconStart="refresh" iconHref={ICONS}>
                            Replay
                          </Button>
                        </span>
                        <span onClick={() => replay(SLOW_RATE)} style={S.click}>
                          <Button
                            variant="secondary"
                            size="sm"
                            iconStart="refresh"
                            iconHref={ICONS}
                          >
                            {SLOW_RATE}×
                          </Button>
                        </span>
                        {/* The answer to a window that cut the shot short. */}
                        <span onClick={keepPlaying} style={S.click}>
                          <Button variant="secondary" size="sm" iconStart="play" iconHref={ICONS}>
                            Keep playing
                          </Button>
                        </span>
                      </div>
                      <div style={S.rule} />
                      <div style={S.endRow}>
                        <span onClick={() => goto(idx - 1)} style={S.click}>
                          <Button
                            variant="tertiary"
                            size="sm"
                            iconStart="chevron-left"
                            iconHref={ICONS}
                          >
                            Previous
                          </Button>
                        </span>
                        <div style={{ flex: 1 }} />
                        <span onClick={() => goto(idx + 1)} style={S.click}>
                          <Button
                            variant="secondary"
                            size="sm"
                            iconEnd="chevron-right"
                            iconHref={ICONS}
                          >
                            {idx < windows.length - 1 ? 'Next' : 'Last'}
                          </Button>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={S.transport}>
            <span onClick={() => goto(idx - 1)} title="Previous swing — ←" style={S.click}>
              <Button
                variant="tertiary"
                size="sm"
                iconOnly
                iconStart="chevron-left"
                aria-label="Previous swing"
                iconHref={ICONS}
              />
            </span>
            <span onClick={toggle} title="Play / pause — space" style={S.click}>
              <Button
                variant="secondary"
                size="sm"
                iconStart={playing ? 'pause' : 'play'}
                iconHref={ICONS}
              >
                {playing ? 'Pause' : atEnd ? 'Replay' : 'Play'}
              </Button>
            </span>
            <span onClick={() => replay(1)} title="Restart window — r" style={S.click}>
              <Button
                variant="tertiary"
                size="sm"
                iconOnly
                iconStart="refresh"
                aria-label="Restart window"
                iconHref={ICONS}
              />
            </span>
            <span onClick={() => replay(SLOW_RATE)} title="Slow-mo replay — s" style={S.click}>
              <Button variant="tertiary" size="sm" iconHref={ICONS}>
                {SLOW_RATE}×
              </Button>
            </span>
            <span onClick={() => goto(idx + 1)} title="Next swing — →" style={S.click}>
              <Button
                variant="tertiary"
                size="sm"
                iconOnly
                iconStart="chevron-right"
                aria-label="Next swing"
                iconHref={ICONS}
              />
            </span>

            <div style={S.padGroup}>
              {/* The direct remedy for a mis-detected window: widen every one of
                  them, without re-running the pipeline. */}
              <span style={S.label}>Pad</span>
              {PAD_STEPS.map((p) => (
                <span key={p} onClick={() => setPadS(p)} style={S.click}>
                  <Button variant={p === padS ? 'secondary' : 'tertiary'} size="sm">
                    {p === 0 ? 'none' : `${p}s`}
                  </Button>
                </span>
              ))}
            </div>

            <span style={{ display: 'inline-flex', flex: 'none' }}>
              <Toggle
                label="Auto-advance"
                checked={autoAdvance}
                onChange={(e: Event) => setAutoAdvance(checkedOf(e))}
              />
            </span>
            <div style={{ flex: 1 }} />
            <span style={S.mono}>{counter}</span>
          </div>

          <div style={S.timelineWrap}>
            <div
              style={S.timeline}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const ms = ((e.clientX - r.left) / r.width) * durationMs;
                const hit = nearestSwing(windows, ms);
                if (hit >= 0) goto(hit);
              }}
            >
              <div
                style={{
                  ...S.timelinePlayed,
                  width: `${timelinePercent(cursorMs, durationMs).toFixed(2)}%`,
                }}
              />
              {windows.map((w, i) => (
                <div
                  key={w.id}
                  title={`${shortId(w.id)} — ${clock(w.startMs)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    goto(i);
                  }}
                  style={{
                    ...S.tick,
                    top: i === idx ? 4 : 9,
                    bottom: i === idx ? 4 : 9,
                    width: i === idx ? 3 : 2,
                    left: `calc(${timelinePercent(w.startMs, durationMs).toFixed(3)}% - 1px)`,
                    background:
                      i === idx
                        ? 'var(--gray-900)'
                        : i < idx
                          ? 'var(--gray-500)'
                          : 'var(--gray-400)',
                  }}
                />
              ))}
              <div
                style={{
                  ...S.cursor,
                  left: `calc(${timelinePercent(cursorMs, durationMs).toFixed(3)}% - 1px)`,
                }}
              />
            </div>
            <div style={S.timelineLabels}>
              <span>0:00</span>
              <span>{clock(cursorMs)}</span>
              <span>{clock(durationMs)}</span>
            </div>
          </div>
        </main>

        <aside style={S.rail}>
          <div style={S.railHead}>
            <span style={S.label}>{windows.length} swings</span>
            <span style={S.mono}>{counter}</span>
          </div>
          <div ref={rail} style={S.railList}>
            {windows.map((w, i) => (
              <div
                key={w.id}
                onClick={() => goto(i)}
                style={{ ...S.row, background: i === idx ? 'var(--gray-200)' : 'transparent' }}
              >
                <div style={S.rowText}>
                  <span
                    style={{
                      ...S.rowId,
                      color: i === idx ? 'var(--gray-900)' : 'var(--gray-700)',
                    }}
                  >
                    {shortId(w.id)}
                  </span>
                  <span style={S.rowAt}>
                    {clock(w.startMs)} · {((w.endMs - w.startMs) / 1000).toFixed(1)}s
                  </span>
                </div>
                <div style={{ flex: 1 }} />
                <span style={S.rowNum}>{String(i + 1).padStart(2, '0')}</span>
              </div>
            ))}
          </div>
          <div style={S.railFoot}>
            <span>← → step</span>
            <span>space pause</span>
            <span>r restart</span>
            <span>s slow</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * Inline because this view is one screen with no reusable parts, and the design
 * it is ported from specifies every value here. Colours are LDS tokens; the
 * stage keeps its own dark surface, since a video frame is not chrome.
 */
const S: Record<string, CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 24,
    padding: '0 20px',
    minHeight: 60,
    flex: 'none',
    background: 'var(--gray-50)',
    borderBottom: '1px solid var(--gray-300)',
  },
  brand: { fontFamily: 'var(--th-display)', fontSize: 23, letterSpacing: '-0.01em' },
  headerGroup: { display: 'flex', alignItems: 'center', gap: 10, flex: 'none' },
  label: {
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: 'var(--gray-500)',
  },
  mono: {
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    color: 'var(--gray-500)',
  },
  body: { flex: 1, minHeight: 0, display: 'flex' },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  stageWrap: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '20px 20px 12px',
  },
  stage: {
    position: 'relative',
    height: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#10130E',
    boxShadow: '0 18px 40px -24px rgba(0,0,0,0.55)',
  },
  video: { height: '100%', maxWidth: '100%', display: 'block', cursor: 'pointer' },
  badgeRow: { position: 'absolute', top: 14, left: 16, display: 'flex', gap: 10 },
  badgeRight: { position: 'absolute', top: 14, right: 16, display: 'flex', gap: 8 },
  badge: {
    fontFamily: 'var(--th-mono)',
    fontSize: 12,
    color: 'rgba(250,249,233,0.92)',
    background: 'rgba(16,19,14,0.55)',
    padding: '4px 8px',
    borderRadius: 4,
  },
  badgeDim: {
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    color: 'rgba(250,249,233,0.62)',
    background: 'rgba(16,19,14,0.45)',
    padding: '4px 6px',
    borderRadius: 4,
  },
  pausedWrap: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  pausedPill: {
    padding: '7px 13px',
    borderRadius: 20,
    background: 'rgba(16,19,14,0.62)',
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'rgba(250,249,233,0.92)',
  },
  windowTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    background: 'rgba(250,249,233,0.12)',
  },
  windowFill: { height: 3, background: 'rgba(250,249,233,0.8)' },
  endScrim: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    background: 'rgba(16,19,14,0.7)',
  },
  endCard: {
    // `min()` rather than a fixed 404: the source here is portrait (1080x1920),
    // so the stage is narrower than the card the landscape design assumed and a
    // fixed width clipped "Keep playing" to "Ke…" against `overflow: hidden`.
    width: 'min(404px, 100%)',
    borderRadius: 10,
    overflow: 'hidden',
    background: 'var(--gray-50)',
    border: '1px solid var(--gray-300)',
  },
  endBar: { height: 3, background: 'var(--gray-200)' },
  endBarFill: { height: 3, background: 'var(--gray-900)' },
  endBody: { display: 'flex', flexDirection: 'column', gap: 14, padding: 16 },
  endHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  endTitle: { fontFamily: 'var(--th-display)', fontSize: 19, letterSpacing: '-0.01em' },
  endRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rule: { height: 1, background: 'var(--gray-200)' },
  click: { display: 'inline-flex', flex: 'none', whiteSpace: 'nowrap', cursor: 'pointer' },
  transport: {
    flex: 'none',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    padding: '0 24px 10px',
  },
  padGroup: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none' },
  timelineWrap: {
    flex: 'none',
    padding: '0 24px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  timeline: {
    position: 'relative',
    height: 34,
    cursor: 'pointer',
    borderRadius: 5,
    background: 'var(--gray-200)',
    overflow: 'hidden',
  },
  timelinePlayed: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--gray-300)' },
  tick: { position: 'absolute', borderRadius: 2 },
  cursor: { position: 'absolute', top: 0, bottom: 0, width: 2, background: '#b3261e' },
  timelineLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    color: 'var(--gray-500)',
  },
  rail: {
    width: 316,
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--gray-50)',
    borderLeft: '1px solid var(--gray-300)',
  },
  railHead: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px 12px',
    borderBottom: '1px solid var(--gray-200)',
  },
  railList: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
    padding: '7px 8px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  rowText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 },
  rowId: { fontFamily: 'var(--th-mono)', fontSize: 12, letterSpacing: '0.02em' },
  rowAt: { fontFamily: 'var(--th-mono)', fontSize: 11, color: 'var(--gray-500)' },
  rowNum: {
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    color: 'var(--gray-500)',
  },
  railFoot: {
    flex: 'none',
    padding: '11px 16px',
    borderTop: '1px solid var(--gray-200)',
    display: 'flex',
    gap: 14,
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--gray-500)',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: 40,
    textAlign: 'center',
  },
  emptyTitle: { fontFamily: 'var(--th-display)', fontSize: 19 },
  emptyBody: { fontSize: 13, color: 'var(--gray-700)', maxWidth: 460, lineHeight: 1.5 },
};
