import type { Dispatch } from 'react';
import type { Action, Ui } from '@/state/store';
import type { Cell, Row } from '@/lib/selectors';
import { commentsOn, pinsFor } from '@/lib/selectors';
import type { Clip, Comment, Phase } from '@/domain/types';
import { autoMeta } from '@/domain/grades';
import { Button, ICONS } from '@/lds';
import { FrameTile, GradeChips, Mono, PlayerCell, StrokeCell } from './shared';

/** Width of the frozen label column, shared by the header and every row. */
const LABEL_COL = 224;

interface Shared {
  roster: string[];
  comments: Comment[];
  ui: Ui;
  dispatch: Dispatch<Action>;
}

function ClipLabel({ clip, roster, comments, ui, dispatch }: Shared & { clip: Clip }) {
  const meta = autoMeta(clip);
  const commentCount = commentsOn(comments, clip.id).length;
  const editingPlayer = ui.editingPlayer === clip.id && !ui.addingPlayer;

  return (
    <div
      style={{
        width: LABEL_COL,
        flex: 'none',
        paddingRight: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          onClick={() => dispatch({ type: 'openDetail', clip: clip.id })}
          style={{
            fontFamily: 'var(--th-mono)',
            fontSize: 11,
            letterSpacing: '0.04em',
            color: 'var(--gray-900)',
            cursor: 'pointer',
            textDecoration: 'underline',
            textDecorationColor: 'var(--gray-300)',
            textUnderlineOffset: 3,
          }}
        >
          {clip.id}
        </span>
        <StrokeCell
          clip={clip}
          editing={ui.editingStroke === clip.id}
          onEdit={() => dispatch({ type: 'editStroke', clip: clip.id })}
          onChange={(stroke) => dispatch({ type: 'setClipStroke', clip: clip.id, stroke })}
          onStopEdit={() => dispatch({ type: 'editStroke', clip: null })}
        />
      </div>

      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--gray-600)' }}
      >
        <PlayerCell
          clip={clip}
          roster={roster}
          editing={editingPlayer}
          onEdit={() => dispatch({ type: 'editPlayer', clip: clip.id })}
          onChange={(player) => dispatch({ type: 'setClipPlayer', clip: clip.id, player })}
        />
        {!editingPlayer && (
          <>
            <span style={{ color: 'var(--gray-300)' }}>/</span>
            <Mono size={10} title={meta.title} style={{ textTransform: 'none' }}>
              {meta.label}
            </Mono>
          </>
        )}
      </div>

      <GradeChips
        clip={clip}
        onGrade={(grade) => dispatch({ type: 'setGrade', clip: clip.id, grade })}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <span
          onClick={() => dispatch({ type: 'openDetail', clip: clip.id })}
          style={{ cursor: 'pointer' }}
        >
          <Button
            variant="tertiary"
            size="sm"
            iconOnly
            iconStart="play"
            aria-label={`Open clip ${clip.id}`}
            iconHref={ICONS}
            hint-size="28px,28px"
          />
        </span>
        <span
          onClick={() => {
            // Jump to the frame a coach would actually comment on: contact if
            // the clip has one, otherwise its first frame.
            const f = clip.frames.find((x) => x.phase === 'contact') ?? clip.frames[0];
            dispatch({ type: 'select', clip: clip.id, frame: f.i });
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            cursor: 'pointer',
            color: 'var(--gray-600)',
            fontFamily: 'var(--th-mono)',
            fontSize: 10,
          }}
        >
          <Button
            variant="tertiary"
            size="sm"
            iconOnly
            iconStart="chat"
            aria-label={`Comments on ${clip.id}`}
            iconHref={ICONS}
            hint-size="28px,28px"
          />
          {commentCount}
        </span>
        <span
          onClick={() => dispatch({ type: 'toggleReject', clip: clip.id })}
          style={{ cursor: 'pointer' }}
        >
          <Button
            variant="tertiary"
            size="sm"
            hue={clip.rejected ? 'green' : 'red'}
            iconOnly
            iconStart={clip.rejected ? 'history' : 'trash'}
            aria-label={clip.rejected ? `Restore clip ${clip.id}` : `Remove clip ${clip.id}`}
            iconHref={ICONS}
            hint-size="28px,28px"
          />
        </span>
      </div>
    </div>
  );
}

function CompareCell({ cell, dispatch }: { cell: Cell; dispatch: Dispatch<Action> }) {
  if (!cell.real) {
    return <div style={{ width: 'var(--tile)', height: 'var(--tileh)', flex: 'none' }} />;
  }
  return (
    <FrameTile
      cell={cell}
      onClick={() => dispatch({ type: 'select', clip: cell.clip, frame: cell.frame })}
      style={{ width: 'var(--tile)', height: 'var(--tileh)', flex: 'none' }}
    />
  );
}

export function CompareTable({
  rows,
  colLabels,
  anchor,
  ...shared
}: Shared & { rows: Row[]; colLabels: string[]; anchor: Phase }) {
  const { dispatch } = shared;

  return (
    <div className="compare" style={{ padding: '22px 24px 60px', minWidth: 'min-content' }}>
      <div
        style={{ position: 'sticky', top: 0, zIndex: 4, background: 'var(--gray-100)', paddingTop: 2 }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 6,
            marginBottom: 10,
            background: 'var(--gray-100)',
            padding: '6px 0 8px',
          }}
        >
          <div style={{ width: LABEL_COL, flex: 'none' }}>
            <Mono size={10} style={{ letterSpacing: '0.09em' }}>
              Aligned on {anchor}
            </Mono>
          </div>
          {colLabels.map((label, i) => (
            <div
              key={`${label}:${i}`}
              style={{
                width: 'var(--tile)',
                flex: 'none',
                textAlign: 'center',
                fontFamily: 'var(--th-mono)',
                fontSize: 10,
                letterSpacing: '0.06em',
                color: 'var(--gray-500)',
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>

      {rows.map(({ clip, cells }) => (
        <div
          key={clip.id}
          className={clip.rejected ? 'is-removed' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 0',
            borderTop: '1px solid var(--gray-200)',
          }}
        >
          <ClipLabel clip={clip} {...shared} />
          {cells.map((cell) => (
            <CompareCell key={cell.key} cell={cell} dispatch={dispatch} />
          ))}
        </div>
      ))}

      {rows.length === 0 && (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--gray-500)', fontSize: 14 }}>
          No clips match these filters.
        </div>
      )}
    </div>
  );
}

/**
 * "Show only this frame" mode: one tile per clip, all showing the same phase,
 * so a dozen contact points can be read side by side without the timeline.
 */
export function FrameGrid({
  clips,
  anchor,
  comments,
  ui,
  dispatch,
}: {
  clips: Clip[];
  anchor: Phase;
  comments: Comment[];
  ui: Ui;
  dispatch: Dispatch<Action>;
}) {
  return (
    <div
      style={{
        padding: '22px 24px 60px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))',
        gap: 16,
      }}
    >
      {clips.map((clip) => {
        const frame = clip.frames.find((f) => f.phase === anchor);
        const pinCount = frame ? pinsFor(comments, clip.id, frame.i).length : 0;
        const cell: Extract<Cell, { real: true }> = {
          real: true,
          key: clip.id,
          clip: clip.id,
          frame: frame?.i ?? 0,
          num: frame ? `f${String(frame.i + 1).padStart(2, '0')}` : 'not tagged',
          phase: anchor,
          flagged: false,
          pinCount,
          selected: frame !== undefined && ui.sel?.clip === clip.id && ui.sel.frame === frame.i,
        };

        return (
          <div
            key={clip.id}
            className={clip.rejected ? 'is-removed' : undefined}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <FrameTile
              cell={cell}
              badgeSize="lg"
              radius={7}
              pinSize={18}
              onClick={() => {
                if (frame) dispatch({ type: 'select', clip: clip.id, frame: frame.i });
              }}
              style={{ aspectRatio: '3 / 2', width: '100%' }}
            />
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
            >
              <span
                onClick={() => dispatch({ type: 'openDetail', clip: clip.id })}
                style={{
                  fontFamily: 'var(--th-mono)',
                  fontSize: 11,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textDecorationColor: 'var(--gray-300)',
                  textUnderlineOffset: 3,
                }}
              >
                {clip.id}
              </span>
              <span style={{ fontSize: 12, color: 'var(--gray-600)' }}>{clip.player}</span>
            </div>
            <GradeChips
              clip={clip}
              onGrade={(grade) => dispatch({ type: 'setGrade', clip: clip.id, grade })}
            />
          </div>
        );
      })}
    </div>
  );
}
