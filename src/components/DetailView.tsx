import type { Dispatch } from 'react';
import type { Action } from '@/state/store';
import { pinsFor } from '@/lib/selectors';
import type { Clip, Comment, Stroke } from '@/domain/types';
import { STROKES } from '@/domain/types';
import { strokeHue } from '@/domain/grades';
import { Button, ICONS, Icon, Select, Tag, Textarea, valueOf } from '@/lds';
import { FrameTile, GradeChips, Mono } from './shared';

export function DetailView({
  clip,
  selectedFrame,
  comments,
  roster,
  playing,
  dispatch,
}: {
  clip: Clip;
  /** Frame index driving the scrubber, or `null` when nothing is selected. */
  selectedFrame: number | null;
  comments: Comment[];
  roster: string[];
  playing: boolean;
  dispatch: Dispatch<Action>;
}) {
  const frameNum = (selectedFrame ?? 0) + 1;
  const progress = `${Math.round((frameNum / clip.frames.length) * 100)}%`;
  const elapsed = `0:0${Math.max(1, Math.round(frameNum / 4))}`;

  return (
    <div style={{ padding: '18px 24px 60px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', rowGap: 10, gap: 12 }}>
        <span
          onClick={() => dispatch({ type: 'closeDetail' })}
          style={{ cursor: 'pointer', whiteSpace: 'nowrap', flex: 'none' }}
        >
          <Button
            variant="tertiary"
            size="sm"
            iconStart="arrow-left"
            iconHref={ICONS}
            hint-size="auto,28px"
          >
            Back to compare
          </Button>
        </span>
        <span style={{ fontFamily: 'var(--th-mono)', fontSize: 12, letterSpacing: '0.04em' }}>
          {clip.id}
        </span>
        <Tag size="sm" hue={strokeHue(clip.stroke)} emphasis="soft" hint-size="auto,20px">
          {clip.stroke}
        </Tag>
        <span style={{ fontSize: 13, color: 'var(--gray-600)' }}>{clip.player}</span>
        <div style={{ flex: 1 }} />
        <Mono style={{ whiteSpace: 'nowrap', flex: 'none' }}>Rate this shot</Mono>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 'none' }}>
          <GradeChips
            clip={clip}
            height={22}
            onGrade={(grade) => dispatch({ type: 'setGrade', clip: clip.id, grade })}
          />
          {clip.grade !== null && (
            <span
              onClick={() => dispatch({ type: 'clearGrade', clip: clip.id })}
              style={{ cursor: 'pointer' }}
            >
              <Button
                variant="tertiary"
                size="sm"
                iconStart="close"
                iconHref={ICONS}
                hint-size="auto,28px"
              >
                Clear
              </Button>
            </span>
          )}
        </div>
      </div>

      <div className="frame-still" style={{ borderRadius: 8, aspectRatio: '16 / 9', maxHeight: 420 }}>
        <span
          style={{
            position: 'absolute',
            left: 16,
            top: 14,
            fontFamily: 'var(--th-mono)',
            fontSize: 10,
            letterSpacing: '0.07em',
            textTransform: 'uppercase',
            color: 'rgba(250,249,233,0.6)',
          }}
        >
          Clip playback — frame {frameNum}
        </span>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: 'linear-gradient(0deg,rgba(4,18,6,0.6),transparent)',
          }}
        >
          <button
            type="button"
            onClick={() => dispatch({ type: 'togglePlay' })}
            aria-label={playing ? 'Pause' : 'Play'}
            style={{
              cursor: 'pointer',
              width: 34,
              height: 34,
              border: 'none',
              padding: 0,
              borderRadius: '50%',
              background: 'var(--gray-50)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon
              name={playing ? 'pause-fill' : 'play-fill'}
              size={16}
              href={ICONS}
              hint-size="16px,16px"
            />
          </button>
          <div
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: 'rgba(250,249,233,0.25)',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: progress,
                background: 'var(--gray-50)',
                borderRadius: 2,
              }}
            />
          </div>
          <span style={{ fontFamily: 'var(--th-mono)', fontSize: 10, color: 'rgba(250,249,233,0.7)' }}>
            {elapsed}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Mono style={{ letterSpacing: '0.09em' }}>Filmstrip — click a frame to inspect</Mono>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {clip.frames.map((f) => (
            <FrameTile
              key={f.i}
              cell={{
                real: true,
                key: `${clip.id}:${f.i}`,
                clip: clip.id,
                frame: f.i,
                num: `f${String(f.i + 1).padStart(2, '0')}`,
                phase: f.phase,
                flagged: false,
                pinCount: pinsFor(comments, clip.id, f.i).length,
                selected: selectedFrame === f.i,
              }}
              pinSize={15}
              onClick={() => dispatch({ type: 'select', clip: clip.id, frame: f.i })}
              style={{ width: 124, height: 82 }}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 16,
          background: 'var(--gray-50)',
          border: '1px solid var(--gray-300)',
          borderRadius: 8,
        }}
      >
        <Mono style={{ letterSpacing: '0.09em' }}>Shot notes</Mono>
        <Textarea
          rows={3}
          aria-label="Shot notes"
          placeholder="What worked, what to fix…"
          value={clip.note}
          onChange={(e: Event) => dispatch({ type: 'setNote', clip: clip.id, note: valueOf(e) })}
          hint-size="100%,80px"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
          gap: 14,
          padding: 16,
          background: 'var(--gray-50)',
          border: '1px solid var(--gray-300)',
          borderRadius: 8,
        }}
      >
        <Select
          label="Player"
          value={clip.player}
          onChange={(e: Event) => dispatch({ type: 'setClipPlayer', clip: clip.id, player: valueOf(e) })}
          options={roster}
          hint-size="100%,60px"
        />
        <Select
          label="Stroke type"
          value={clip.stroke}
          onChange={(e: Event) =>
            dispatch({ type: 'setClipStroke', clip: clip.id, stroke: valueOf(e) as Stroke })
          }
          options={[...STROKES]}
          hint-size="100%,60px"
        />
      </div>
    </div>
  );
}
