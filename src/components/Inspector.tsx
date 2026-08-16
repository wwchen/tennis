import type { Dispatch, MouseEvent } from 'react';
import type { MenuItem } from '@lew-ds/lds/templates';
import type { Action } from '@/state/store';
import type { Clip, Comment, Frame, Phase } from '@/domain/types';
import { autoMeta } from '@/domain/grades';
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

export function Inspector({
  clip,
  frame,
  pins,
  draft,
  dispatch,
}: {
  clip: Clip | undefined;
  frame: Frame | undefined;
  pins: Comment[];
  draft: string;
  dispatch: Dispatch<Action>;
}) {
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

          <div className="frame-still" style={{ borderRadius: 6, aspectRatio: '3 / 2' }}>
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
              style={{
                fontFamily: 'var(--th-mono)',
                fontSize: 11,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                textDecorationColor: 'var(--gray-300)',
              }}
            >
              {clip.id}
            </span>
            <Mono size={11} title={autoMeta(clip).title} style={{ textTransform: 'none' }}>
              {autoMeta(clip).label}
            </Mono>
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
      style={{
        width: 312,
        flex: 'none',
        overflowY: 'auto',
        background: 'var(--gray-50)',
        borderLeft: '1px solid var(--gray-300)',
        padding: '20px 18px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      {body}
    </aside>
  );
}
