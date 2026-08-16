import type { Dispatch } from 'react';
import type { Action, Ui } from '@/state/store';
import { commentsOn } from '@/lib/selectors';
import type { Clip, Comment } from '@/domain/types';
import { gradeOf, PHASES } from '@/domain/grades';
import { Button, ICONS, Icon, Tag } from '@/lds';
import { GradeChips, Mono, PlayerCell, StrokeCell } from './shared';

function CatalogCard({
  clip,
  comments,
  roster,
  ui,
  dispatch,
}: {
  clip: Clip;
  comments: Comment[];
  roster: string[];
  ui: Ui;
  dispatch: Dispatch<Action>;
}) {
  const grade = gradeOf(clip.grade);
  const commentCount = commentsOn(comments, clip.id).length;

  return (
    <div
      className={clip.rejected ? 'is-removed' : undefined}
      style={{
        background: 'var(--gray-50)',
        border: '1px solid var(--gray-300)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => dispatch({ type: 'openDetail', clip: clip.id })}
        className="frame-still"
        style={{ height: 158, cursor: 'pointer', border: 'none' }}
      >
        <span
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            fontFamily: 'var(--th-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: 'rgba(250,249,233,0.75)',
          }}
        >
          {clip.id}
        </span>
        <span style={{ position: 'absolute', right: 12, top: 10 }}>
          <Tag size="sm" hue={grade.hue} emphasis="strong" hint-size="auto,20px">
            {grade.label}
          </Tag>
        </span>
        <span
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%,-50%)',
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'rgba(250,249,233,0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="play-fill" size={18} href={ICONS} hint-size="18px,18px" />
        </span>
        <span
          style={{
            position: 'absolute',
            right: 12,
            bottom: 10,
            fontFamily: 'var(--th-mono)',
            fontSize: 9,
            color: 'rgba(250,249,233,0.62)',
          }}
        >
          {clip.duration}
        </span>
      </div>

      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 15, minWidth: 0 }}>
            <PlayerCell
              clip={clip}
              roster={roster}
              editing={ui.editingPlayer === clip.id && !ui.addingPlayer}
              onEdit={() => dispatch({ type: 'editPlayer', clip: clip.id })}
              onChange={(player) => dispatch({ type: 'setClipPlayer', clip: clip.id, player })}
              fontSize={15}
            />
          </span>
          <StrokeCell
            clip={clip}
            editing={ui.editingStroke === clip.id}
            onEdit={() => dispatch({ type: 'editStroke', clip: clip.id })}
            onChange={(stroke) => dispatch({ type: 'setClipStroke', clip: clip.id, stroke })}
            onStopEdit={() => dispatch({ type: 'editStroke', clip: null })}
          />
        </div>

        {/* Setup / contact / finish shortcut strip — jumps the inspector
            straight to that phase's frame without opening the clip. */}
        <div style={{ display: 'flex', gap: 4 }}>
          {PHASES.map((phase) => {
            const frame = clip.frames.find((f) => f.phase === phase);
            return (
              <button
                key={phase}
                type="button"
                disabled={frame === undefined}
                onClick={() => {
                  if (frame) dispatch({ type: 'select', clip: clip.id, frame: frame.i });
                }}
                className="frame-still"
                aria-label={`${phase} frame of ${clip.id}`}
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: 4,
                  padding: 0,
                  cursor: frame ? 'pointer' : 'default',
                  appearance: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: 4,
                    bottom: 3,
                    fontFamily: 'var(--th-mono)',
                    fontSize: 8,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'rgba(250,249,233,0.7)',
                  }}
                >
                  {phase}
                </span>
              </button>
            );
          })}
        </div>

        <GradeChips
          clip={clip}
          onGrade={(grade) => dispatch({ type: 'setGrade', clip: clip.id, grade })}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 2,
          }}
        >
          <Mono size={10} style={{ textTransform: 'none' }}>
            {commentCount} comments
          </Mono>
          <span
            onClick={() => dispatch({ type: 'toggleReject', clip: clip.id })}
            style={{ cursor: 'pointer' }}
          >
            <Button
              variant="tertiary"
              size="sm"
              hue={clip.rejected ? 'green' : 'red'}
              iconStart={clip.rejected ? 'history' : 'trash'}
              iconHref={ICONS}
              hint-size="auto,28px"
            >
              {clip.rejected ? 'Restore' : 'Remove'}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function CatalogView({
  clips,
  comments,
  roster,
  ui,
  dispatch,
}: {
  clips: Clip[];
  comments: Comment[];
  roster: string[];
  ui: Ui;
  dispatch: Dispatch<Action>;
}) {
  return (
    <div
      style={{
        padding: '22px 24px 60px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))',
        gap: 16,
      }}
    >
      {clips.map((clip) => (
        <CatalogCard
          key={clip.id}
          clip={clip}
          comments={comments}
          roster={roster}
          ui={ui}
          dispatch={dispatch}
        />
      ))}
    </div>
  );
}
