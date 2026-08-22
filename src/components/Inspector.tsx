import type { Dispatch, MouseEvent } from 'react';
import { useRef, useState } from 'react';
import type { MenuItem } from '@lew-ds/lds/templates';
import type { Action } from '@/state/store';
import type { Clip, Comment, Frame, Phase } from '@/domain/types';
import { shortId } from '@/domain/types';
import { Avatar, Button, ICONS, Icon, Menu, Textarea, valueOf } from '@/lds';
import { Mono } from './shared';

/**
 * Order of the phase-reclassification menu. It is also the delegation key: the
 * LDS Menu template renders one `.lds-menu__item` button per entry and the
 * React binding wires no per-item click handler, so the click is caught on the
 * wrapper and matched back to this array by index.
 */
const PHASE_MENU: (Phase | null)[] = ['setup', 'contact', 'finish', null];

const MENU_LABEL: Record<string, string> = {
  setup: 'Setup',
  contact: 'Contact',
  finish: 'Finish',
  null: 'Unlabeled (in-between)',
};

const MENU_HINT: Record<string, string> = { setup: 'S', contact: 'C', finish: 'F', null: '⌥' };

function Empty() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 40,
        textAlign: 'center',
        alignItems: 'center',
        color: 'var(--gray-500)',
      }}
    >
      <Icon name="photo-stack" size={28} href={ICONS} hint-size="28px,28px" />
      <div style={{ fontSize: 14, maxWidth: 220, lineHeight: 1.45 }}>
        Click any frame to study it, pin a note, or fix an auto-tag.
      </div>
    </div>
  );
}

/** The sheet's grab bar. Drag thresholds are asymmetric on purpose: 40px to
 *  expand, 60px to dismiss, because dismissing discards the selection. */
function SheetHandle({
  label,
  full,
  onToggle,
  onDismiss,
  onDrag,
}: {
  label: string;
  full: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  onDrag: (direction: 'up' | 'down') => void;
}) {
  const startY = useRef<number | null>(null);

  return (
    <div
      onClick={onToggle}
      title={full ? 'Collapse' : 'Expand'}
      onTouchStart={(e) => {
        startY.current = e.touches[0].clientY;
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const dy = e.touches[0].clientY - startY.current;
        if (dy < -40) {
          startY.current = null;
          onDrag('up');
        } else if (dy > 60) {
          startY.current = null;
          onDrag('down');
        }
      }}
      onTouchEnd={() => {
        startY.current = null;
      }}
      style={{
        position: 'sticky',
        top: -20,
        zIndex: 2,
        margin: '-20px -18px 0',
        padding: '10px 18px 8px',
        background: 'var(--gray-50)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        cursor: 'grab',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 44, height: 4, borderRadius: 2, background: 'var(--gray-300)' }} />
      <div
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Mono style={{ letterSpacing: '0.09em' }}>{label}</Mono>
        <span
          onClick={(e) => {
            // The bar behind this toggles the sheet; dismissing must not also
            // expand it on the way out.
            e.stopPropagation();
            onDismiss();
          }}
          style={{ cursor: 'pointer' }}
        >
          <Button
            variant="tertiary"
            size="sm"
            iconOnly
            iconStart="close"
            aria-label="Dismiss inspector"
            iconHref={ICONS}
            hint-size="28px,28px"
          />
        </span>
      </div>
    </div>
  );
}

export function Inspector({
  clip,
  frame,
  pins,
  draft,
  playing,
  mobile,
  sheetFull,
  dispatch,
}: {
  clip: Clip | undefined;
  frame: Frame | undefined;
  pins: Comment[];
  draft: string;
  /** Whether the inspector's own clip player is running. */
  playing: boolean;
  /** Render as a sheet rising from the bottom rather than a column. */
  mobile: boolean;
  /** Whether that sheet is expanded to full height. */
  sheetFull: boolean;
  dispatch: Dispatch<Action>;
}) {
  // Local, not in the store: this ticks several times a second while a clip
  // runs, and routing it through the reducer would re-render every row in the
  // grid for a 3px bar. Reset on `play` rather than in an effect — the element
  // is keyed by clip, so a new clip mounts a fresh one and fires `play` again.
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  /** Native fullscreen: a scrubber, frame stepping and volume for free.
   *  `webkitEnterFullscreen` is the iOS Safari path. */
  const goFullscreen = () => {
    const el = videoRef.current;
    if (el === null) return;
    const legacy = el as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().catch(() => {
        // Denied by permissions policy, or already exiting. Nothing to do.
      });
    } else if (typeof legacy.webkitEnterFullscreen === 'function') {
      legacy.webkitEnterFullscreen();
    }
  };


  const playable = clip?.videoUrl !== undefined;
  const body =
    clip === undefined || frame === undefined ? (
      <Empty />
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Mono style={{ letterSpacing: '0.09em' }}>Frame inspector</Mono>
            <span onClick={() => dispatch({ type: 'clearSelection' })} style={{ cursor: 'pointer' }}>
              <Button
                variant="tertiary"
                size="sm"
                iconOnly
                iconStart="close"
                aria-label="Clear selection"
                iconHref={ICONS}
                hint-size="28px,28px"
              />
            </span>
          </div>

          {/* The inspected frame, doubling as the clip player: the row's play
              button answers "was that a shot?" here rather than navigating
              away. `contain` because the ETL's crop is the framing decision. */}
          <div
            className="frame-still"
            onClick={playable ? () => dispatch({ type: 'toggleInspectorPlay' }) : undefined}
            title={playable ? (playing ? 'Pause' : 'Play clip') : undefined}
            style={{ borderRadius: 6, aspectRatio: '3 / 4', cursor: playable ? 'pointer' : 'default' }}
          >
            {playing && clip.videoUrl !== undefined ? (
              <video
                key={clip.id}
                ref={videoRef}
                src={clip.videoUrl}
                autoPlay
                playsInline
                muted
                onPlay={() => setProgress(0)}
                onEnded={() => dispatch({ type: 'toggleInspectorPlay' })}
                onTimeUpdate={(e) => {
                  const el = e.currentTarget;
                  setProgress(el.duration > 0 ? (el.currentTime / el.duration) * 100 : 0);
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                }}
              />
            ) : (
              frame.imageUrl !== undefined && (
                <img
                  src={frame.imageUrl}
                  alt=""
                  role="presentation"
                  decoding="async"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                  }}
                />
              )
            )}


            {playing && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Play fullscreen"
                title="Fullscreen"
                onClick={(e) => {
                  // The box behind this toggles pause; fullscreen must not do both.
                  e.stopPropagation();
                  goFullscreen();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  goFullscreen();
                }}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: 8,
                  width: 26,
                  height: 26,
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: 'rgba(250,249,233,0.92)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* The sprite has no fullscreen glyph; `arrow-all` is the
                    four-way expand, which is the nearest thing it carries. */}
                <Icon name="arrow-all" size={14} href={ICONS} hint-size="14px,14px" />
              </span>
            )}

            {playing && (
              <span
                style={{
                  position: 'absolute',
                  left: 10,
                  top: 9,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '2px 7px',
                  borderRadius: 3,
                  background: 'rgba(250,249,233,0.92)',
                  fontFamily: 'var(--th-mono)',
                  fontSize: 9,
                  letterSpacing: '0.07em',
                  textTransform: 'uppercase',
                  color: 'var(--gray-900)',
                }}
              >
                Playing
              </span>
            )}

            {playable && (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 3,
                  background: 'rgba(250,249,233,0.2)',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    height: 3,
                    width: `${playing ? progress : 0}%`,
                    background: 'var(--gray-50)',
                  }}
                />
              </span>
            )}
            <span
              style={{
                position: 'absolute',
                left: 8,
                bottom: 6,
                fontFamily: 'var(--th-mono)',
                fontSize: 10,
                color: 'rgba(250,249,233,0.65)',
              }}
            >
              frame {String(frame.i + 1).padStart(2, '0')} of{' '}
              {String(clip.frames.length).padStart(2, '0')}
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 13,
              color: 'var(--gray-700)',
            }}
          >
            <span
              onClick={() => dispatch({ type: 'openDetail', clip: clip.id })}
              title={clip.id}
              style={{
                fontFamily: 'var(--th-mono)',
                fontSize: 11,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                textDecorationColor: 'var(--gray-300)',
              }}
            >
              {shortId(clip.id)}
            </span>
            {/*
              Remove, right under the clip you just watched.

              The same verdict is on every compare row, but reaching it means
              finding that row again in a list of 124 after the panel has
              already answered the question the clip was played to answer. This
              is where the decision actually gets made, so this is where the
              button belongs.
            */}
            <span
              onClick={() => dispatch({ type: 'toggleReject', clip: clip.id })}
              style={{ cursor: 'pointer' }}
              title={clip.rejected ? 'Restore this clip' : 'Remove: not a swing'}
            >
              <Button
                variant="tertiary"
                size="sm"
                hue={clip.rejected ? 'green' : 'red'}
                iconStart={clip.rejected ? 'history' : 'trash'}
                aria-label={clip.rejected ? `Restore clip ${clip.id}` : `Remove clip ${clip.id}`}
                iconHref={ICONS}
                hint-size="auto,28px"
              >
                {clip.rejected ? 'Restore' : 'Not a swing'}
              </Button>
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 14,
            borderTop: '1px solid var(--gray-200)',
          }}
        >
          <Mono style={{ letterSpacing: '0.09em' }}>Comments on this frame</Mono>
          {pins.map((c) => (
            <div key={c.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
              <Avatar name={c.author} size="xs" hint-size="22px,22px" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{c.author}</span>
                  <span
                    style={{ fontFamily: 'var(--th-mono)', fontSize: 9, color: 'var(--gray-500)' }}
                  >
                    {c.at}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: 'var(--gray-700)',
                    textWrap: 'pretty',
                  }}
                >
                  {c.text}
                </div>
              </div>
            </div>
          ))}
          {pins.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--gray-500)' }}>
              No comments pinned here yet.
            </div>
          )}

          <Textarea
            rows={3}
            aria-label="Comment on this frame"
            placeholder="Comment on this frame…"
            value={draft}
            onChange={(e: Event) => dispatch({ type: 'setDraft', value: valueOf(e) })}
            hint-size="100%,80px"
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <span onClick={() => dispatch({ type: 'postComment' })} style={{ cursor: 'pointer' }}>
              <Button
                variant="primary"
                size="sm"
                iconStart="chat"
                iconHref={ICONS}
                hint-size="auto,32px"
              >
                Pin comment
              </Button>
            </span>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 14,
            borderTop: '1px solid var(--gray-200)',
          }}
        >
          <Mono style={{ letterSpacing: '0.09em' }}>
            Auto-tagged {frame.phase ?? 'in-between'} — fix if wrong
          </Mono>
          <div
            onClick={(e: MouseEvent<HTMLDivElement>) => {
              const target = e.target;
              if (!(target instanceof Element)) return;
              const item = target.closest('.lds-menu__item');
              if (!item) return;
              const index = Array.from(
                e.currentTarget.querySelectorAll('.lds-menu__item'),
              ).indexOf(item);
              if (index < 0) return;
              dispatch({ type: 'setPhase', clip: clip.id, frame: frame.i, phase: PHASE_MENU[index] });
            }}
          >
            <Menu
              // `items` is the one list-shaped prop lds-react does NOT widen in
              // its types: the runtime flattens a React node in label/icon/hint
              // (components.jsx `listSlotKeys`), but the .d.ts still inherits
              // the vanilla `Slot` from @lew-ds/lds. The cast tracks the runtime.
              items={
                PHASE_MENU.map((p) => ({
                  label: MENU_LABEL[String(p)],
                  icon:
                    p === frame.phase ? (
                      <Icon name="check" size={16} href={ICONS} hint-size="16px,16px" />
                    ) : undefined,
                  hint: MENU_HINT[String(p)],
                })) as unknown as MenuItem[]
              }
              hint-size="100%,160px"
            />
          </div>
        </div>
      </div>
    );

  return (
    <aside
      className="inspector-panel"
      style={
        mobile
          ? {
              // A sheet, and only when there is something to inspect. On a
              // desktop an empty inspector is a hint; on a phone it would be a
              // permanent band across the bottom of a small screen saying
              // nothing.
              position: 'fixed',
              zIndex: 29,
              left: 0,
              right: 0,
              bottom: 0,
              height: sheetFull ? '86vh' : 268,
              overflowY: 'auto',
              background: 'var(--gray-50)',
              borderTop: '1px solid var(--gray-300)',
              borderRadius: '14px 14px 0 0',
              boxShadow: '0 -8px 32px rgba(19,32,18,0.18)',
              padding: '20px 18px 40px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
              transition: 'height 180ms ease',
            }
          : {
              flex: 'none',
              overflowY: 'auto',
              background: 'var(--gray-50)',
              padding: '20px 18px 40px',
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }
      }
    >
      {mobile && frame !== undefined && (
        <SheetHandle
          label={
            clip === undefined
              ? 'Frame inspector'
              : `${shortId(clip.id)} · frame ${String(frame.i + 1).padStart(2, '0')}`
          }
          full={sheetFull}
          onToggle={() => dispatch({ type: 'setSheetFull', value: !sheetFull })}
          onDismiss={() => dispatch({ type: 'clearSelection' })}
          onDrag={(direction) => {
            if (direction === 'up') dispatch({ type: 'setSheetFull', value: true });
            else if (sheetFull) dispatch({ type: 'setSheetFull', value: false });
            else dispatch({ type: 'clearSelection' });
          }}
        />
      )}
      {body}
    </aside>
  );
}
