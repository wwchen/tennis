import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Clip } from '@/domain/types';
import { shortId } from '@/domain/types';
import { Button, ICONS, Select, valueOf } from '@/lds';
import type { EtlSource } from '@/domain/etl-types';
import { SwingMetadata } from './SwingMetadata';
import { clipExportFileName, clipExportUrl } from './clip-export';
import {
  END_MODES,
  END_MODE_LABELS,
  PAD_STEPS,
  SHORTCUTS,
  SPEED_STEPS,
  axisTicks,
  clock,
  nearestSwing,
  outsideWindow,
  playWindow,
  rateLabel,
  remainingMs,
  stepSpeed,
  timelinePercent,
  windowProgress,
  windowsFor,
  type EndMode,
} from './source-playback';
import {
  CLASS_COLOUR,
  CONF_STEPS,
  DEFAULT_CLASSES,
  DEFAULT_CONF,
  OBJECT_CLASSES,
  boxRect,
  drawnBoxes,
  frameAt,
  objectsUrl,
  sampleLifeMs,
  videoContentRect,
  type ObjectClass,
  type ObjectsDoc,
  type VideoBox,
} from './object-overlay';

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

interface Props {
  clips: Clip[];
  /** `/api/media/<session>/source.mp4`, or undefined when there is no proxy. */
  proxyUrl?: string;
  /** Source length in ms, for the timeline. */
  durationMs: number;
  /** What the probe read off the source video, for the details panel. */
  probe?: EtlSource | null;
  /** The detector's tuning for this session. */
  settings?: Record<string, unknown> | null;
  /** Candidate/verified/rejected counts and the reject histogram. */
  detection?: Record<string, unknown> | null;
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

/**
 * The hidden-swing set for a session, or an empty one.
 *
 * Every failure reads as "nothing hidden": a private window, storage disabled,
 * or a value some other tool wrote. That errs toward showing MORE than the
 * reviewer asked for, which is recoverable; the opposite would silently hide
 * swings they never chose to hide.
 */
function readHidden(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function KeyframeReview({
  clips,
  proxyUrl,
  durationMs,
  probe,
  settings,
  detection,
  session,
  sessions,
  onSession,
  onSelect,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  // Clicked by the `e` shortcut: a download needs a real anchor activation, so
  // the key drives the same element rather than duplicating the URL building.
  const exportRef = useRef<HTMLAnchorElement>(null);

  const windows = useMemo(() => windowsFor(clips), [clips]);
  const [idx, setIdx] = useState(0);
  const [padS, setPadS] = useState<number>(0);
  const [endMode, setEndMode] = useState<EndMode>('stop');
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [cursorMs, setCursorMs] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  // A DEADLINE, not a remaining count. Decrementing a counter by a fixed step
  // per timer tick assumes the tick is punctual, and a background tab clamps
  // `setTimeout` to about a second — so a 4s countdown stepping 100ms at a time
  // took 40s there and looked stalled. Against a deadline a late timer simply
  // finds the time already passed and advances at once.
  const [deadline, setDeadline] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [held, setHeld] = useState(false);
  /** Set by "Keep playing": drops the window bound until the next selection. */
  const [unbounded, setUnbounded] = useState(false);
  const [tab, setTab] = useState<'swings' | 'details'>('swings');
  const [showKeys, setShowKeys] = useState(false);
  /**
   * The session's per-frame detections, or null when it has none.
   *
   * Null is the ordinary state, not a failure: the object pass is optional and
   * most sessions were never put through it. Nothing is said about it either
   * way — the controls simply do not appear.
   */
  const [objects, setObjects] = useState<ObjectsDoc | null>(null);
  const [shownClasses, setShownClasses] = useState<Set<ObjectClass>>(
    () => new Set(DEFAULT_CLASSES),
  );
  const [confFloor, setConfFloor] = useState<number>(DEFAULT_CONF);
  /**
   * The video element's own size and the size of the picture inside it.
   *
   * Kept in state rather than read during render because both change without
   * React: the element is letterboxed and resizes with the window, and its
   * intrinsic size is unknown until `loadedmetadata`. A box drawn from a stale
   * measurement is a box in the wrong place, which is worse than no box.
   */
  const [videoBox, setVideoBox] = useState<VideoBox | null>(null);
  // Dropped during render on a session change, the same reset-on-input pattern
  // the hidden set and the selection above use. Clearing it inside the fetch
  // effect instead would leave the old session's boxes on screen for the frame
  // between the switch and the effect running — over the new session's video.
  const [seenObjectSession, setSeenObjectSession] = useState(session);
  if (seenObjectSession !== session) {
    setSeenObjectSession(session);
    setObjects(null);
  }
  /**
   * Swings the reviewer has hidden, by id.
   *
   * Kept per session in `localStorage` rather than written to `user-edit.json`:
   * hiding is a view preference — "stop showing me this while I work through
   * the session" — and the ETL's `verdict` vocabulary means something stronger
   * and permanent. Promoting a hidden swing to `verdict: duplicate` is the
   * right follow-up, but conflating the two would record a judgement the
   * reviewer did not make.
   */
  const hideKey = `shot-lab:hidden:${session}`;
  const [hidden, setHidden] = useState<Set<string>>(() => readHidden(hideKey));
  // Re-read when the session changes, during render rather than in an effect:
  // the same reset-on-input-change pattern the selection uses, and it avoids
  // painting one frame of the previous session's hidden set.
  const [seenHideKey, setSeenHideKey] = useState(hideKey);
  const starKey = `shot-lab:starred:${session}`;
  const [starred, setStarred] = useState<Set<string>>(() => readHidden(starKey));
  if (seenHideKey !== hideKey) {
    setSeenHideKey(hideKey);
    setHidden(readHidden(hideKey));
    setStarred(readHidden(starKey));
  }

  const toggleStar = useCallback(
    (id: string) => {
      setStarred((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(starKey, JSON.stringify([...next]));
        } catch {
          // See `toggleHidden`: not worth interrupting the reviewer over.
        }
        return next;
      });
    },
    [starKey],
  );

  const toggleHidden = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(hideKey, JSON.stringify([...next]));
        } catch {
          // Storage full or blocked: the session still works, it just will not
          // be remembered. Not worth interrupting the reviewer over.
        }
        return next;
      });
    },
    [hideKey],
  );

  // Switching session swaps the whole swing list and reloads the element to 0,
  // but `idx` is component state and survived — so the rail highlighted swing 16
  // of the NEW session while the playhead sat at 0:00, a minute before it.
  // Pressing play then ran from 0:00 until it happened to reach that window's
  // end, which is why the boundary looked broken.
  //
  // Adjusted during render rather than in an effect: this is React's own
  // "reset state when an input changes" pattern, and it re-renders before
  // anything is painted instead of showing one frame of the stale selection.
  // Compared on the first swing's id, not the array — `windowsFor` rebuilds
  // the list on every clips render, so depending on the array itself would
  // throw away the reviewer's selection on unrelated state changes.
  const firstId = windows[0]?.id;
  const [seenFirstId, setSeenFirstId] = useState(firstId);
  if (firstId !== seenFirstId) {
    setSeenFirstId(firstId);
    setIdx(0);
    setAtEnd(false);
    setUnbounded(false);
  }
  // The seek itself is left to the paused-reseek effect below: the element has
  // reloaded to 0, which is before the first window's start, so it moves the
  // playhead there — and a DOM mutation has no business happening in render.

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
    // 'continue' is folded into `unbounded` here rather than checked in the
    // watcher, so there is one flag deciding whether the boundary bites.
    boundary.current = { endMs: bounds?.endMs ?? Infinity, unbounded: unbounded || endMode === 'continue' };
  }, [bounds, unbounded, endMode]);

  const stopAtWindowEnd = useCallback(() => {
    const el = video.current;
    if (el === null || el.paused) return;
    const { endMs, unbounded: free } = boundary.current;
    if (free || el.currentTime * 1000 < endMs) return;
    el.pause();
    setAtEnd(true);
    setDeadline(Date.now() + HOLD_MS);
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

  /**
   * The next index in `step` direction that is not hidden.
   *
   * Hiding has to bind navigation, not just the list: a hidden swing that
   * arrows and auto-advance still land on has not been hidden in any sense the
   * reviewer meant. Falls back to `from` when everything in that direction is
   * hidden, so the selection never runs off the end.
   */
  const skipHidden = useCallback(
    (from: number, step: number): number => {
      if (step === 0) return from;
      let i = from;
      while (i >= 0 && i < windows.length && hidden.has(windows[i].id)) i += step;
      return i >= 0 && i < windows.length ? i : from;
    },
    [windows, hidden],
  );

  /** Seek to a window and play it. The only path that moves the selection. */
  const goto = useCallback(
    (next: number, playRate?: number) => {
      const wanted = Math.max(0, Math.min(windows.length - 1, next));
      const clamped = skipHidden(wanted, next >= idx ? 1 : -1);
      const target = windows[clamped];
      if (target === undefined) return;
      const { startMs } = playWindow(target, durationMs, padS);
      setIdx(clamped);
      setAtEnd(false);
      setCountdown(0);
      setHeld(false);
      setUnbounded(false);
      const useRate = playRate ?? rate;
      setRate(useRate);
      onSelect?.(target.id);

      const el = video.current;
      if (el === null) return;
      el.playbackRate = useRate;
      el.currentTime = startMs / 1000;
      // Autoplay can be refused before the page has been interacted with. The
      // seek still landed, so the right frame is on screen, merely paused.
      void el.play().catch(() => undefined);
    },
    [windows, durationMs, padS, onSelect, skipHidden, idx, rate],
  );

  /** Replay the current window at whatever rate is currently set. */
  const replay = useCallback(() => goto(idx, rate), [goto, idx, rate]);

  /**
   * Change the playback rate, on the element as well as in state.
   *
   * Applied to the live element rather than waiting for the next `goto`, so
   * `<` while a swing is playing slows THAT swing — which is the moment a
   * reviewer reaches for it.
   */
  const nudgeSpeed = useCallback((step: number) => {
    setRate((r) => {
      const next = stepSpeed(r, step);
      if (video.current !== null) video.current.playbackRate = next;
      return next;
    });
  }, []);

  const toggle = useCallback(() => {
    const el = video.current;
    if (el === null) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    // Resuming at the end of a window replays it; resuming from a pause in the
    // middle of one simply continues. Resuming from OUTSIDE it seeks back in
    // first — otherwise play runs from wherever the playhead happens to be,
    // which after a session change is the top of the video.
    if (atEnd || (bounds !== null && outsideWindow(el.currentTime * 1000, bounds.startMs, bounds.endMs))) {
      replay();
      return;
    }
    void el.play().catch(() => undefined);
  }, [atEnd, replay, bounds]);

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
    if (!atEnd || endMode !== 'next' || held) return;
    if (idx >= windows.length - 1) return;
    const timer = setTimeout(() => {
      // Both the readout and the advance happen on the timer: advancing from
      // the effect body instead makes selecting a swing a render-time side
      // effect, which cascades renders and trips react-hooks/set-state-in-effect.
      const left = deadline - Date.now();
      if (left <= 0) goto(idx + 1);
      else setCountdown(left);
    }, 100);
    return () => clearTimeout(timer);
  }, [atEnd, endMode, held, countdown, deadline, idx, windows.length, goto]);

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
        replay();
      } else if (e.key === '<' || e.key === ',') {
        // Both, because `<` needs shift on most layouts and a reviewer reaching
        // for "slower" mid-swing should not have to think about which.
        e.preventDefault();
        nudgeSpeed(-1);
      } else if (e.key === '>' || e.key === '.') {
        e.preventDefault();
        nudgeSpeed(1);
      } else if (e.key === 's' || e.key === 'S') {
        if (current !== undefined) toggleStar(current.id);
      } else if (e.key === 'x' || e.key === 'X') {
        if (current !== undefined) toggleHidden(current.id);
      } else if (e.key === 'e' || e.key === 'E') {
        exportRef.current?.click();
      } else if (e.key === '?') {
        setShowKeys((v) => !v);
      } else if (e.key === 'Escape') {
        setShowKeys(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goto, idx, toggle, replay, current, toggleHidden, toggleStar, nudgeSpeed]);

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

  // The object export, refetched per session and abandoned on the way out: a
  // 30k-line file can still be arriving when the reviewer switches, and landing
  // late would paint the previous session's boxes over this one's video.
  //
  // Every failure lands on `null`, which is the same state as "never exported":
  // 404, a truncated file, no dev middleware at all. There is nothing a reviewer
  // could do about any of them, and an error banner over a video is a poor way
  // to say that an optional extra pass was not run.
  useEffect(() => {
    const stop = new AbortController();
    fetch(objectsUrl(session), { signal: stop.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ObjectsDoc>) : null))
      .then(setObjects)
      .catch(() => undefined);
    return () => stop.abort();
  }, [session]);

  /**
   * Re-read the element's box and the picture's size inside it.
   *
   * Returns the PREVIOUS object when the numbers have not changed. This runs on
   * every resize frame, and a fresh object each time would re-render the whole
   * view for a window drag that moved nothing.
   */
  const measure = useCallback(() => {
    const el = video.current;
    if (el === null) return;
    setVideoBox((prev) => {
      const next: VideoBox = {
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
      };
      const same =
        prev !== null &&
        prev.clientWidth === next.clientWidth &&
        prev.clientHeight === next.clientHeight &&
        prev.videoWidth === next.videoWidth &&
        prev.videoHeight === next.videoHeight;
      return same ? prev : next;
    });
  }, []);

  // A ResizeObserver rather than a window listener: the stage is flex-sized, so
  // the element's box also changes when the rail opens or the transport row
  // wraps, neither of which fires a resize event.
  useEffect(() => {
    const el = video.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const toggleClass = useCallback((cls: ObjectClass) => {
    setShownClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });
  }, []);

  // The picker lists only playable sessions, but the app still LOADS whichever
  // session the tree lists first — `IMG_0304`, which has no source video. That
  // left the picker showing one session while the view rendered another's empty
  // state. If the loaded session cannot be played here, move to one that can.
  //
  // Calling a prop rather than setting local state, so this is a request to the
  // owner of the selection, not a second copy of it. It settles in one step:
  // the session it asks for is in the list, so the condition is false next time.
  const playableSession = sessions.length > 0 && !sessions.includes(session) ? sessions[0] : null;
  useEffect(() => {
    if (playableSession !== null) onSession(playableSession);
  }, [playableSession, onSession]);

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

  // The boxes for whatever frame is on screen. `cursorMs` is updated by the two
  // watchers above, so this follows playback without a clock of its own — and
  // the sample is the one AT OR BEFORE the playhead, never interpolated: at
  // 15 m/s the ball moves most of a torso height between native frames, so a
  // line drawn between two samples runs through positions it was never in.
  const content = videoBox === null ? null : videoContentRect(videoBox);
  const boxes =
    objects === null
      ? []
      : drawnBoxes(
          frameAt(objects.frames, cursorMs, sampleLifeMs(objects.header.fps)),
          shownClasses,
          confFloor,
        );

  return (
    <div style={S.root}>
      {showKeys && (
        <div style={S.keysScrim} onClick={() => setShowKeys(false)}>
          <div style={S.keysCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.keysHead}>
              <span style={S.endTitle}>Keyboard</span>
              <span style={S.label}>esc to close</span>
            </div>
            {SHORTCUTS.map((k) => (
              <div key={k.what} style={S.keysRow}>
                <kbd style={S.kbd}>{k.label}</kbd>
                <span style={{ fontSize: 13 }}>{k.what}</span>
              </div>
            ))}
          </div>
        </div>
      )}
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
                onLoadedMetadata={measure}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />

              {/*
                What the object detector saw, over the frame it saw it on.
                `pointerEvents: none` throughout, so click-to-pause still
                reaches the video underneath a box sitting in the middle of it.
              */}
              {objects !== null && content !== null && (
                <div style={S.overlay}>
                  {boxes.map(({ cls, box }, i) => {
                    const r = boxRect(box, content, objects.header);
                    return (
                      // Index-keyed on purpose: a detection has no identity
                      // across frames, and the whole set is rebuilt each time
                      // the playhead moves to a new sample.
                      <div
                        key={`${cls}-${i}`}
                        style={{
                          ...S.box,
                          left: r.left,
                          top: r.top,
                          width: r.width,
                          height: r.height,
                          borderColor: CLASS_COLOUR[cls],
                        }}
                      >
                        <span style={{ ...S.boxLabel, color: CLASS_COLOUR[cls] }}>
                          {cls} {box[4].toFixed(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={S.badgeRow}>
                <span style={S.badge}>
                  {current !== undefined && starred.has(current.id) ? '★ ' : ''}
                  {current === undefined ? '—' : shortId(current.id)}
                </span>
                <span style={S.badgeDim}>
                  {bounds === null
                    ? '—'
                    : `${clock(bounds.startMs, true)} → ${clock(bounds.endMs, true)}`}
                </span>
              </div>

              <div style={S.badgeRight}>
                {unbounded && <span style={S.badgeDim}>past window</span>}
                {rate !== 1 && <span style={S.badgeDim}>{rate}×</span>}
                {/* Seconds LEFT, not the clock: the previous readout was the
                    position in the source, which answers "where am I" — a
                    question the axis already answers — and never "when does
                    this stop", which was the one actually being asked. */}
                <span style={S.badgeCount}>
                  {bounds === null || unbounded
                    ? clock(cursorMs, true)
                    : `${(remainingMs(cursorMs, bounds.startMs, bounds.endMs) / 1000).toFixed(1)}s left`}
                </span>
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
                      setDeadline(Date.now() + HOLD_MS);
                      setCountdown(HOLD_MS);
                    }}
                  >
                    <div style={S.endBar}>
                      <div
                        style={{
                          ...S.endBarFill,
                          width:
                            endMode === 'next' && idx < windows.length - 1
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
                        {endMode === 'next' && idx < windows.length - 1 && (
                          <span style={S.label}>
                            {held ? 'held' : `next in ${Math.max(0, countdown / 1000).toFixed(1)}s`}
                          </span>
                        )}
                      </div>
                      <div style={S.endRow}>
                        <span onClick={() => replay()} style={S.click}>
                          <Button variant="primary" size="sm" iconStart="refresh" iconHref={ICONS}>
                            Replay (r)
                          </Button>
                        </span>
                        {/* The one-off twin of the standing `continue` mode:
                            this swing only, without changing what happens at
                            the end of the next one. */}
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
            {/* The two swing arrows sit TOGETHER, and carry the glyph of the
                key that drives them. Previously next-swing landed immediately
                after the speed control's `>`, so two adjacent buttons showed
                the same chevron and did entirely different things. Matching
                each button to its own key (← → for swings, < > for speed) is
                what tells them apart at a glance. */}
            <div style={S.padGroup}>
              <span onClick={() => goto(idx - 1)} title="Previous swing (←)" style={S.click}>
                <Button variant="tertiary" size="sm" aria-label="Previous swing">
                  ←
                </Button>
              </span>
              <span onClick={() => goto(idx + 1)} title="Next swing (→)" style={S.click}>
                <Button variant="tertiary" size="sm" aria-label="Next swing">
                  →
                </Button>
              </span>
            </div>
            <span onClick={toggle} title="Play / pause — space" style={S.click}>
              <Button
                variant="secondary"
                size="sm"
                iconStart={playing ? 'pause' : 'play'}
                iconHref={ICONS}
              >
                {playing ? 'Pause' : atEnd ? 'Replay' : 'Play'} (space)
              </Button>
            </span>
            <span onClick={() => replay()} title="Replay the window" style={S.click}>
              <Button variant="tertiary" size="sm" iconStart="refresh" iconHref={ICONS}>
                Replay (r)
              </Button>
            </span>
            <div style={S.padGroup}>
              <span style={S.label}>Speed</span>
              <span
                onClick={() => nudgeSpeed(-1)}
                title="Slower (<)"
                style={{ ...S.click, opacity: rate === SPEED_STEPS[0] ? 0.4 : 1 }}
              >
                <Button variant="tertiary" size="sm">
                  &lt;
                </Button>
              </span>
              <span style={S.rateBadge}>{rateLabel(rate)}</span>
              <span
                onClick={() => nudgeSpeed(1)}
                title="Faster (>)"
                style={{ ...S.click, opacity: rate === SPEED_STEPS[SPEED_STEPS.length - 1] ? 0.4 : 1 }}
              >
                <Button variant="tertiary" size="sm">
                  &gt;
                </Button>
              </span>
            </div>
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

            {/*
              Only for a session that HAS an export. The controls are the only
              thing that says the overlay exists, so showing them dead would
              advertise boxes that can never appear.

              A floor and per-class toggles rather than a single on/off, because
              the export applies no selection at all: at its own `conf 0.10` it
              carries several boxes on one racket and further ones on the net
              post, so an unfiltered overlay is not what any later stage acts on.
            */}
            {objects !== null && (
              <div style={S.padGroup}>
                <span
                  style={S.label}
                  title={`${objects.header.detector} · ${objects.header.weights} · sampled at ${objects.header.fps.toFixed(0)}fps`}
                >
                  Boxes
                </span>
                {OBJECT_CLASSES.map((cls) => (
                  <span key={cls} onClick={() => toggleClass(cls)} style={S.click}>
                    <Button variant={shownClasses.has(cls) ? 'secondary' : 'tertiary'} size="sm">
                      {cls}
                    </Button>
                  </span>
                ))}
                <span style={S.label} title="Hide boxes the detector was less sure of than this">
                  Conf
                </span>
                {CONF_STEPS.map((c) => (
                  <span key={c} onClick={() => setConfFloor(c)} style={S.click}>
                    <Button variant={c === confFloor ? 'secondary' : 'tertiary'} size="sm">
                      {c.toFixed(2)}
                    </Button>
                  </span>
                ))}
              </div>
            )}

            <div style={S.padGroup}>
              <span style={S.label}>At end</span>
              {END_MODES.map((m) => (
                <span
                  key={m}
                  onClick={() => setEndMode(m)}
                  title={END_MODE_LABELS[m].title}
                  style={S.click}
                >
                  <Button variant={m === endMode ? 'secondary' : 'tertiary'} size="sm">
                    {END_MODE_LABELS[m].label}
                  </Button>
                </span>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            {current !== undefined && (
              // The pad goes with it: the exported file is the window as it is
              // being watched, so widening a bad window and exporting gives the
              // clip the reviewer actually just saw, not the detector's guess.
              //
              // `dir` is rebuilt from the id rather than threaded through the
              // Clip: `shortId` yields `swing_005`, and `swings/<that>` is
              // exactly the `dir` /api/session reports for every swing.
              <a
                href={clipExportUrl({
                  session,
                  dir: `swings/${shortId(current.id)}`,
                  startMs: current.startMs,
                  endMs: current.endMs,
                  padS,
                })}
                download={clipExportFileName({
                  session,
                  dir: `swings/${shortId(current.id)}`,
                  startMs: current.startMs,
                  endMs: current.endMs,
                  padS,
                })}
                ref={exportRef}
                title="Download this swing as a video file (e)"
                style={S.click}
              >
                <Button variant="tertiary" size="sm" iconStart="download" iconHref={ICONS}>
                  Export (e)
                </Button>
              </a>
            )}
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
              {axisTicks(durationMs).map((ms) => (
                <div
                  key={`grid-${ms}`}
                  style={{
                    ...S.grid,
                    left: `${timelinePercent(ms, durationMs).toFixed(3)}%`,
                  }}
                />
              ))}
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
            <div style={S.axis}>
              {axisTicks(durationMs).map((ms, i, all) => {
                const pct = timelinePercent(ms, durationMs);
                // The first and last labels are pulled inside the track rather
                // than centred, so neither overhangs the edge it marks.
                const edge = i === 0 ? 'left' : i === all.length - 1 ? 'right' : 'mid';
                return (
                  <span
                    key={ms}
                    style={{
                      ...S.axisLabel,
                      left: edge === 'right' ? undefined : `${pct}%`,
                      right: edge === 'right' ? 0 : undefined,
                      transform: edge === 'mid' ? 'translateX(-50%)' : undefined,
                    }}
                  >
                    {clock(ms)}
                  </span>
                );
              })}
            </div>
          </div>
        </main>

        <aside style={S.rail}>
          <div style={S.railHead}>
            <span onClick={() => setTab('swings')} style={S.click}>
              <Button variant={tab === 'swings' ? 'secondary' : 'tertiary'} size="sm">
                {windows.length} swings
              </Button>
            </span>
            <span onClick={() => setTab('details')} style={S.click}>
              <Button variant={tab === 'details' ? 'secondary' : 'tertiary'} size="sm">
                Details
              </Button>
            </span>
            <div style={{ flex: 1 }} />
            <span style={S.mono}>{counter}</span>
          </div>
          {(hidden.size > 0 || starred.size > 0) && (
            <div style={S.hiddenBar}>
              <span style={S.mono}>
                {starred.size > 0 && `${starred.size} starred`}
                {starred.size > 0 && hidden.size > 0 && ' · '}
                {hidden.size > 0 && `${hidden.size} hidden`}
              </span>
            </div>
          )}
          {tab === 'details' && (
            <div style={S.railList}>
              <SwingMetadata
                clip={clips.find((c) => c.id === current?.id)}
                source={probe ?? null}
                settings={settings ?? null}
                detection={detection ?? null}
              />
            </div>
          )}
          <div ref={rail} style={{ ...S.railList, display: tab === 'swings' ? undefined : 'none' }}>
            {windows.map((w, i) => {
              const isHidden = hidden.has(w.id);
              return (
                <div
                  key={w.id}
                  onClick={() => goto(i)}
                  style={{
                    ...S.row,
                    background: i === idx ? 'var(--gray-200)' : 'transparent',
                    opacity: isHidden ? 0.4 : 1,
                  }}
                >
                  <div style={S.rowText}>
                    <span
                      style={{
                        ...S.rowId,
                        color: i === idx ? 'var(--gray-900)' : 'var(--gray-700)',
                        textDecoration: isHidden ? 'line-through' : undefined,
                      }}
                    >
                      {shortId(w.id)}
                    </span>
                    <span style={S.rowAt}>
                      {clock(w.startMs)} · {((w.endMs - w.startMs) / 1000).toFixed(1)}s
                    </span>
                  </div>
                  <div style={{ flex: 1 }} />
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleStar(w.id);
                    }}
                    title={starred.has(w.id) ? 'Unstar this swing (s)' : 'Star this swing (s)'}
                    style={{
                      ...S.rowMark,
                      color: starred.has(w.id) ? 'var(--gray-900)' : 'var(--gray-400)',
                    }}
                  >
                    {starred.has(w.id) ? '★' : '☆'}
                  </span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleHidden(w.id);
                    }}
                    title={isHidden ? 'Show this swing (x)' : 'Hide this swing (x)'}
                    style={S.rowMark}
                  >
                    {isHidden ? '+' : '×'}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={S.railFoot}>
            <span onClick={() => setShowKeys(true)} style={{ ...S.click, cursor: 'pointer' }}>
              <Button variant="tertiary" size="sm">
                ? shortcuts
              </Button>
            </span>
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
  // Sized to the ELEMENT, not the picture: `videoContentRect` has already put
  // the letterbox offset into every box's own `left`/`top`, so this layer is
  // simply the element's own coordinate space.
  overlay: { position: 'absolute', inset: 0, pointerEvents: 'none' },
  box: { position: 'absolute', border: '2px solid', borderRadius: 2 },
  boxLabel: {
    position: 'absolute',
    left: 0,
    // Above the box rather than inside it: a ball box is about 20px square on
    // this footage, so a label inside it covers the thing being looked at.
    bottom: '100%',
    marginBottom: 2,
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    padding: '1px 3px',
    borderRadius: 3,
    background: 'rgba(16,19,14,0.62)',
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
  // Positioned, not `space-between`: a label has to sit AT its own time, which
  // is the whole difference between an axis and three strings in a row.
  axis: {
    position: 'relative',
    height: 12,
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    color: 'var(--gray-500)',
  },
  axisLabel: { position: 'absolute', top: 0, whiteSpace: 'nowrap' },
  grid: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    background: 'var(--gray-300)',
    opacity: 0.7,
  },
  badgeCount: {
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    color: 'rgba(250,249,233,0.92)',
    background: 'rgba(16,19,14,0.55)',
    padding: '4px 6px',
    borderRadius: 4,
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
  rateBadge: {
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    letterSpacing: '0.04em',
    color: 'var(--gray-700)',
    // Fixed, not a minimum: "0.75x" is wider than "1x", so a minWidth let the
    // badge grow and shoved Export onto a second row every time the rate
    // changed. Sized for the widest label the steps can produce.
    width: 42,
    flex: 'none',
    textAlign: 'center',
  },
  rowMark: {
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--gray-500)',
    cursor: 'pointer',
    padding: '2px 5px',
  },
  hiddenBar: {
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    borderBottom: '1px solid var(--gray-200)',
  },
  keysScrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(16,19,14,0.55)',
  },
  keysCard: {
    width: 320,
    maxWidth: '90%',
    padding: 20,
    borderRadius: 10,
    background: 'var(--gray-50)',
    border: '1px solid var(--gray-300)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  keysHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  keysRow: { display: 'flex', alignItems: 'center', gap: 12 },
  kbd: {
    minWidth: 42,
    textAlign: 'center',
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    padding: '3px 6px',
    borderRadius: 4,
    background: 'var(--gray-200)',
    border: '1px solid var(--gray-300)',
  },
  railFoot: {
    flex: 'none',
    padding: '11px 16px',
    borderTop: '1px solid var(--gray-200)',
    display: 'flex',
    justifyContent: 'center',
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
