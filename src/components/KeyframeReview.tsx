import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import type { Clip } from '@/domain/types';
import { NO_SESSION, shortId } from '@/domain/types';
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
  OBJECT_CLASSES,
  readOverlayPrefs,
  writeOverlayPrefs,
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
import {
  CANDIDATE_COLOUR,
  LABEL_COLOUR,
  LABEL_WRITE_MS,
  OFFERED_COLOUR,
  ballCandidatesUrl,
  ballLabelsDoc,
  ballLabelsUrl,
  centreOf,
  firstFrameOf,
  labelKey,
  lastPosition,
  nearestFrame,
  parseBallLabels,
  pickCandidate,
  pointRect,
  sourcePoint,
  windowAt,
  windowProgress as ballWindowProgress,
  type BallCandidatesDoc,
  type BallLabels,
} from './ball-labels';

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
  // Restored from the last visit rather than reset to the defaults. How a
  // reviewer likes to look at a swing is not a per-session judgement, so it
  // outlives both the reload and the session switch.
  const [shownClasses, setShownClasses] = useState<Set<ObjectClass>>(
    () => readOverlayPrefs().classes,
  );
  const [confFloor, setConfFloor] = useState<number>(() => readOverlayPrefs().conf);
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
  /**
   * The ball candidates to confirm, and the human's answers so far.
   *
   * `labels` is null until the file on disk has been READ, and the write effect
   * below refuses to send anything while it is. That gate is the only thing
   * standing between a session switch and an empty document overwriting somebody
   * else's ground truth: the reset below drops the previous session's labels
   * during render, so between the switch and the fetch landing there is a moment
   * where an ungated writer would PUT `{}` over a full file.
   */
  const [candidates, setCandidates] = useState<BallCandidatesDoc | null>(null);
  const [labels, setLabels] = useState<BallLabels | null>(null);
  /** Set when the file exists but this build cannot read it — see the 409 route. */
  const [labelsUnreadable, setLabelsUnreadable] = useState(false);
  const [labelling, setLabelling] = useState(false);
  /** Index into `candidates.frames`, which is the transport while labelling. */
  const [frameIdx, setFrameIdx] = useState(0);
  /** Which of this frame's candidate boxes `a` would accept. */
  const [candIdx, setCandIdx] = useState(0);
  // The payload last written to disk, per session, so a bare page load does not
  // PUT back what it has only just read. Same rule and same reason as the
  // `lastSentRef` cache in the store's `user-edit.json` write-back.
  const sentLabels = useRef(new Map<string, string>());

  const [seenObjectSession, setSeenObjectSession] = useState(session);
  if (seenObjectSession !== session) {
    setSeenObjectSession(session);
    setObjects(null);
    // Dropped for the same reason the boxes are, and with more at stake: a
    // label is keyed by timestamp alone, so the previous session's labels
    // carried into this one would be written to THIS session's file under keys
    // that name moments in a different video.
    setCandidates(null);
    setLabels(null);
    setLabelsUnreadable(false);
    setLabelling(false);
    setFrameIdx(0);
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
      // Selecting a swing plays it, and labelling is a paused, frame-by-frame
      // mode — so clicking the rail or the timeline leaves the mode rather than
      // leaving a labelling cursor pointing at a frame that has scrolled past.
      setLabelling(false);
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

  /**
   * Put the labelling cursor on a frame: seek to it, and offer a candidate.
   *
   * The seek is a DOM mutation from an event handler, like `goto`'s, rather than
   * an effect watching `frameIdx` — the frame on screen and the frame being
   * labelled must be the same one, and an effect makes that true one render
   * late, which at a keypress per frame is a label filed against the previous
   * picture.
   *
   * `labelsNow` is passed rather than read from state because the caller has
   * just added a label and React has not re-rendered yet: anchoring the next
   * offer on stale labels would ignore the position the human accepted a
   * keystroke ago, which is the one thing that makes the offer worth anything.
   */
  const seekFrame = useCallback(
    (frames: BallCandidatesDoc['frames'], labelsNow: BallLabels, next: number) => {
      if (frames.length === 0) return;
      const clamped = Math.max(0, Math.min(frames.length - 1, next));
      const boxes = frames[clamped].ball ?? [];
      setFrameIdx(clamped);
      setCandIdx(Math.max(0, pickCandidate(boxes, lastPosition(frames, clamped, labelsNow))));
      const el = video.current;
      if (el === null) return;
      el.pause();
      el.currentTime = frames[clamped].ms / 1000;
    },
    [],
  );

  /**
   * Record a verdict on the current frame and move to the next.
   *
   * The advance is the point: every one of `a`, `n` and a click is one keystroke
   * or one click for one frame, and a separate "next" press would double the
   * cost of a pass measured in hundreds of frames.
   *
   * `null` is written, not deleted — "a human looked and there is no ball here"
   * is a label, and the absence of a key is the different claim that nobody has
   * looked. Telling those apart is most of what these labels are for.
   */
  const applyLabel = useCallback(
    (value: [number, number] | null) => {
      const frames = candidates?.frames;
      if (frames === undefined || labels === null) return;
      const frame = frames[frameIdx];
      if (frame === undefined) return;
      const next = { ...labels, [labelKey(frame.ms)]: value };
      setLabels(next);
      seekFrame(frames, next, frameIdx + 1);
    },
    [candidates, labels, frameIdx, seekFrame],
  );

  /** Take back a verdict, leaving the frame unlabelled and the cursor on it. */
  const clearLabel = useCallback(() => {
    const frames = candidates?.frames;
    if (frames === undefined || labels === null) return;
    const frame = frames[frameIdx];
    if (frame === undefined) return;
    // Deleted rather than set to null: this is "nobody has looked at this
    // frame", which is exactly what an absent key means and what a null does
    // not. Staying on the frame is deliberate — an unlabel is a correction, and
    // advancing would carry the reviewer away from the thing they came back to.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [labelKey(frame.ms)]: _removed, ...rest } = labels;
    setLabels(rest);
  }, [candidates, labels, frameIdx]);

  /** Step the labelling cursor by whole frames. */
  const stepFrame = useCallback(
    (delta: number) => {
      const frames = candidates?.frames;
      if (frames === undefined || labels === null) return;
      seekFrame(frames, labels, frameIdx + delta);
    },
    [candidates, labels, frameIdx, seekFrame],
  );

  /**
   * Jump to the first frame of the previous or next labelling window.
   *
   * The windows are minutes apart in the source — contact ±500ms of twenty
   * sampled swings across eight minutes — so stepping between them by frame is
   * not a thing anyone can do. A window is also the unit the progress readout
   * counts, which makes it the unit a reviewer finishes.
   */
  const gotoLabelWindow = useCallback(
    (delta: number) => {
      const frames = candidates?.frames;
      const wins = candidates?.header.windows;
      if (frames === undefined || wins === undefined || labels === null) return;
      const frame = frames[frameIdx];
      const here = frame === undefined ? -1 : windowAt(wins, frame.ms);
      const target = wins[Math.max(0, Math.min(wins.length - 1, here + delta))];
      if (target === undefined) return;
      const first = firstFrameOf(frames, target);
      if (first >= 0) seekFrame(frames, labels, first);
    },
    [candidates, labels, frameIdx, seekFrame],
  );

  /**
   * Take the offered candidate's CENTRE as the label.
   *
   * The centre and not the box: a label is a position, and the box is one
   * detector's opinion of an extent. Anything measuring a tracker later needs a
   * point to compare against, and deriving one from a stored box would bake
   * this detector's idea of the ball's size into ground truth.
   */
  const acceptCandidate = useCallback(() => {
    const box = candidates?.frames[frameIdx]?.ball?.[candIdx];
    if (box === undefined) return;
    applyLabel(centreOf(box));
  }, [candidates, frameIdx, candIdx, applyLabel]);

  /** Offer the next candidate box, for a frame where the nearest was wrong. */
  const cycleCandidate = useCallback(() => {
    const boxes = candidates?.frames[frameIdx]?.ball ?? [];
    if (boxes.length === 0) return;
    setCandIdx((i) => (i + 1) % boxes.length);
  }, [candidates, frameIdx]);

  /**
   * Enter or leave labelling, landing on the frame nearest the playhead.
   *
   * Nearest, so pressing `b` while watching a swing starts labelling the window
   * the reviewer was already looking at rather than at the top of the file.
   * `currentTime` is read off the element instead of from `cursorMs` so this
   * callback does not have to be rebuilt on every animation frame.
   */
  const toggleLabelling = useCallback(() => {
    if (labelling) {
      setLabelling(false);
      return;
    }
    const frames = candidates?.frames;
    // `labels === null` is "the file on disk has not been read yet", and
    // labelling from that state would write a document built from nothing.
    if (frames === undefined || frames.length === 0 || labels === null) return;
    const at = nearestFrame(frames, (video.current?.currentTime ?? 0) * 1000);
    seekFrame(frames, labels, at < 0 ? 0 : at);
    setLabelling(true);
  }, [labelling, candidates, labels, seekFrame]);

  // Keyboard, as the design specifies: arrows step, space pauses, r restarts,
  // s slows. Ignored while a field has focus, so typing a note is not transport.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Labelling REBINDS the arrows from swings to frames, and claims the four
      // verdict keys, before the transport below sees them. Handled as a mode
      // rather than as extra keys because labelling is frame-by-frame work: a
      // reviewer confirming sixty frames of a window should not be reaching for
      // a second pair of keys to step through them.
      if (labelling) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const delta = e.key === 'ArrowRight' ? 1 : -1;
          if (e.shiftKey) gotoLabelWindow(delta);
          else stepFrame(delta);
          return;
        }
        if (e.key === 'a' || e.key === 'A') {
          acceptCandidate();
          return;
        }
        if (e.key === 'n' || e.key === 'N') {
          applyLabel(null);
          return;
        }
        if (e.key === 'c' || e.key === 'C') {
          cycleCandidate();
          return;
        }
        if (e.key === 'Backspace') {
          // Prevented because in a browser Backspace outside a field is still
          // "go back" on some setups, and losing a labelling pass to a
          // navigation is the one mistake this key must not be able to make.
          e.preventDefault();
          clearLabel();
          return;
        }
      }
      if (e.key === 'b' || e.key === 'B') {
        toggleLabelling();
        return;
      }
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
        // The way out of the mode for a reviewer who does not remember `b`.
        setLabelling(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    goto,
    idx,
    toggle,
    replay,
    current,
    toggleHidden,
    toggleStar,
    nudgeSpeed,
    labelling,
    toggleLabelling,
    stepFrame,
    gotoLabelWindow,
    acceptCandidate,
    applyLabel,
    cycleCandidate,
    clearLabel,
  ]);

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

  // The ball candidates, on the same terms as the object export above: refetched
  // per session, abandoned on the way out, and every failure landing on `null`,
  // which is the same state as "the candidate pass was never run over this
  // session". Most sessions have none — the pass covers a hand-picked sample —
  // so a session with no labelling controls is the ordinary case, not a fault.
  useEffect(() => {
    // Not before a session has loaded. `session` carries NO_SESSION until then,
    // and fetching against it produced two aborted requests on every page load.
    if (session === NO_SESSION) return undefined;
    const stop = new AbortController();
    fetch(ballCandidatesUrl(session), { signal: stop.signal })
      .then((r) => (r.ok ? (r.json() as Promise<BallCandidatesDoc>) : null))
      .then(setCandidates)
      .catch(() => undefined);
    return () => stop.abort();
  }, [session]);

  // The labels already on disk. A 404 is "nobody has labelled this session yet"
  // and starts an empty pass; a 409 is a file this build cannot parse, which is
  // somebody's ground truth in a shape it must not overwrite, so labelling stays
  // off and says why. Every other failure leaves `labels` null, which the write
  // effect below reads as "not loaded" and refuses to send from.
  useEffect(() => {
    if (session === NO_SESSION) return undefined;
    const stop = new AbortController();
    fetch(ballLabelsUrl(session), { signal: stop.signal })
      .then(async (r) => {
        if (r.status === 404) return {};
        if (!r.ok) return null;
        return parseBallLabels(await (r.json() as Promise<unknown>))?.labels ?? null;
      })
      .then((loaded) => {
        if (loaded === null) {
          setLabelsUnreadable(true);
          return;
        }
        // Seeded here, not on the first write: without it the very next run of
        // the write effect would PUT the document it has just read straight back
        // to disk, from a page load with no human action behind it.
        sentLabels.current.set(session, JSON.stringify(ballLabelsDoc(session, loaded)));
        setLabels(loaded);
      })
      .catch(() => undefined);
    return () => stop.abort();
  }, [session]);

  /**
   * Write the labels back, shortly after the last one.
   *
   * Debounced rather than written per keypress because a labelling pass is a
   * keypress per frame, and the file is the whole session — but the debounce is
   * short (`LABEL_WRITE_MS`) because the quantity it bounds is human work at
   * risk, not requests per second. Twenty minutes of labelling lost to a reload
   * would be unforgivable; half a second of it is a frame nobody minds redoing.
   */
  useEffect(() => {
    if (labels === null) return;
    const payload = JSON.stringify(ballLabelsDoc(session, labels));
    if (sentLabels.current.get(session) === payload) return;
    const timer = setTimeout(() => {
      void fetch(ballLabelsUrl(session), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
        .then((res) => {
          // `fetch` resolves for 4xx/5xx too, and caching a rejected payload as
          // sent would retire those labels permanently.
          if (res.ok) sentLabels.current.set(session, payload);
        })
        .catch(() => undefined);
    }, LABEL_WRITE_MS);
    return () => clearTimeout(timer);
  }, [labels, session]);

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

  const toggleClass = useCallback(
    (cls: ObjectClass) => {
      setShownClasses((prev) => {
        const next = new Set(prev);
        if (next.has(cls)) next.delete(cls);
        else next.add(cls);
        writeOverlayPrefs({ classes: next, conf: confFloor });
        return next;
      });
    },
    [confFloor],
  );

  const chooseConf = useCallback(
    (c: number) => {
      setConfFloor(c);
      writeOverlayPrefs({ classes: shownClasses, conf: c });
    },
    [shownClasses],
  );

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

  // The labelling cursor: which frame, what the detector offered on it, and
  // what the human has said about it so far. All null when the mode is off or
  // the session has no candidate file, which is most of them.
  const labelFrame = labelling ? (candidates?.frames[frameIdx] ?? null) : null;
  const labelBoxes = labelFrame?.ball ?? [];
  // `undefined` is "nobody has looked at this frame" and `null` is "a human
  // looked and there was no ball". The readout below keeps them apart, because
  // they are the two different things this whole file exists to record.
  const labelAt = labelFrame === null ? undefined : labels?.[labelKey(labelFrame.ms)];
  const labelWins = candidates?.header.windows ?? [];
  const labelWinIdx = labelFrame === null ? -1 : windowAt(labelWins, labelFrame.ms);
  const labelWin = labelWinIdx < 0 ? null : labelWins[labelWinIdx];
  const labelDone =
    labelWin === null || candidates === null
      ? null
      : ballWindowProgress(candidates.frames, labelWin, labels ?? {});

  /**
   * Correct the detector: put the ball where the human says it is.
   *
   * The click is measured against the ELEMENT and then mapped through
   * `content`, which is where the picture actually sits inside its letterbox —
   * the same rectangle the boxes are drawn against, so a click that lands on a
   * candidate box records that box's position. A click on the letterbox bars
   * records nothing rather than a ball clamped to the edge of the frame.
   */
  const placeLabel = (e: MouseEvent<HTMLVideoElement>) => {
    if (content === null || candidates === null) return;
    const r = e.currentTarget.getBoundingClientRect();
    const point = sourcePoint(e.clientX - r.left, e.clientY - r.top, content, candidates.header);
    if (point === null) return;
    applyLabel(point);
  };

  return (
    <div style={S.root}>
      {showKeys && (
        <div style={S.keysScrim} onClick={() => setShowKeys(false)}>
          <div style={S.keysCard} onClick={(e) => e.stopPropagation()}>
            <div style={S.keysHead}>
              <span style={S.endTitle}>Keyboard</span>
              <span style={S.label}>esc to close</span>
            </div>
            {SHORTCUTS.map((k, i) => (
              <Fragment key={k.what}>
                {/* A heading before the first mode entry, because these REPLACE
                    the arrows above rather than adding to them — a flat list
                    would show `← →` twice with two meanings and no rule. */}
                {k.mode === 'ball' && SHORTCUTS[i - 1]?.mode !== 'ball' && (
                  <div style={S.keysGroup}>While labelling the ball</div>
                )}
                <div style={S.keysRow}>
                  <kbd style={S.kbd}>{k.label}</kbd>
                  <span style={{ fontSize: 13 }}>{k.what}</span>
                </div>
              </Fragment>
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
                // A crosshair while labelling, because the click means something
                // else there: it places the ball rather than toggling playback.
                style={labelling ? { ...S.video, cursor: 'crosshair' } : S.video}
                onClick={(e) => {
                  if (labelling) placeLabel(e);
                  else toggle();
                }}
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

              {/*
                What there is to confirm on THIS frame, and what has been
                confirmed. Drawn over the same picture rectangle as the object
                overlay above and with `pointerEvents: none` for the same
                reason — a click anywhere on the stage has to reach the video,
                which is what turns "the box is wrong" into one click on the
                right spot rather than a hunt for a gap between boxes.
              */}
              {labelling && content !== null && candidates !== null && (
                <div style={S.overlay}>
                  {labelBoxes.map((box, i) => {
                    const r = boxRect(box, content, candidates.header);
                    const offered = i === candIdx;
                    return (
                      // Index-keyed, like the overlay above: a detection has no
                      // identity, and `candIdx` addresses this list by position.
                      <div
                        key={`cand-${i}`}
                        style={{
                          ...S.box,
                          left: r.left,
                          top: r.top,
                          width: r.width,
                          height: r.height,
                          borderColor: offered ? OFFERED_COLOUR : CANDIDATE_COLOUR,
                          borderWidth: offered ? 2 : 1,
                        }}
                      >
                        {offered && (
                          <span style={{ ...S.boxLabel, color: OFFERED_COLOUR }}>
                            a · {box[4].toFixed(2)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {labelAt !== undefined && labelAt !== null && (
                    // A crosshair, not a box: the label IS a point, and drawing
                    // it as a rectangle would suggest a size no human recorded.
                    <div
                      style={{
                        ...S.crosshair,
                        ...pointRect(labelAt, content, candidates.header),
                      }}
                    />
                  )}
                </div>
              )}

              {labelling && (
                <div style={S.labelBar}>
                  <span style={S.badge}>
                    {labelWinIdx < 0 ? 'window —' : `window ${labelWinIdx + 1}/${labelWins.length}`}
                  </span>
                  {labelDone !== null && (
                    <span style={S.badgeDim}>
                      {labelDone.labelled}/{labelDone.total} labelled ·{' '}
                      {labelDone.total - labelDone.labelled} left
                    </span>
                  )}
                  <span style={S.badgeDim}>
                    {labelAt === undefined
                      ? 'unlabelled'
                      : labelAt === null
                        ? 'no ball'
                        : `${labelAt[0].toFixed(0)}, ${labelAt[1].toFixed(0)}`}
                  </span>
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

              {/* Not while labelling: the video is paused for every frame of a
                  labelling pass by definition, so the pill would be a permanent
                  overlay saying something the reviewer already knows — and it
                  swallows the click that places the ball. */}
              {!playing && !atEnd && !labelling && (
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
                  <span key={c} onClick={() => chooseConf(c)} style={S.click}>
                    <Button variant={c === confFloor ? 'secondary' : 'tertiary'} size="sm">
                      {c.toFixed(2)}
                    </Button>
                  </span>
                ))}
              </div>
            )}

            {/*
              Only for a session the candidate pass has been run over, on the
              same terms as the Boxes controls above: the button is the only
              thing that says the mode exists, and offering it where there is
              nothing to confirm would advertise a blank frame-stepper.
            */}
            {candidates !== null && (
              <div style={S.padGroup}>
                <span
                  onClick={toggleLabelling}
                  title={`Confirm or correct the ball, frame by frame (b) — ${candidates.header.windows.length} windows at native rate`}
                  style={S.click}
                >
                  <Button variant={labelling ? 'primary' : 'tertiary'} size="sm">
                    {labelling ? 'Labelling ball' : 'Label ball (b)'}
                  </Button>
                </span>
                {labelling && labelDone !== null && (
                  <span style={S.mono}>
                    {labelDone.labelled}/{labelDone.total} · {labelDone.total - labelDone.labelled}{' '}
                    left
                  </span>
                )}
              </div>
            )}

            {/*
              The one failure worth saying out loud. Everything else about this
              feature degrades to "no controls"; this one means a `ball-labels.json`
              exists that this build cannot parse, and the app is deliberately
              refusing to start a pass that would replace it.
            */}
            {labelsUnreadable && (
              <span
                style={S.label}
                title="ball-labels.json exists but is not a document this build can read, so labelling is off rather than overwriting it"
              >
                ball labels unreadable
              </span>
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
  // A 9px ring centred on the point by the negative margins. Small on purpose:
  // a ball is about 20px across on this footage, so a marker much bigger than
  // this covers the thing the reviewer is checking it against.
  crosshair: {
    position: 'absolute',
    width: 9,
    height: 9,
    marginLeft: -5,
    marginTop: -5,
    borderRadius: '50%',
    border: `2px solid ${LABEL_COLOUR}`,
  },
  labelBar: {
    position: 'absolute',
    left: 16,
    bottom: 14,
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
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
    // The list is now two groups and outgrows a short window; capped and
    // scrolled rather than clipped by the card's own rounding.
    maxHeight: '82vh',
    overflowY: 'auto',
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
  keysGroup: {
    marginTop: 8,
    paddingTop: 8,
    borderTop: '1px solid var(--gray-200)',
    fontFamily: 'var(--th-mono)',
    fontSize: 10,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    color: 'var(--gray-500)',
  },
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
