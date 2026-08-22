import type { CSSProperties, ReactNode } from 'react';
import type { Cell } from '@/lib/selectors';
import type { Clip, Grade, Phase, Stroke } from '@/domain/types';
import type { SkippedSwing } from '@/domain/etl';
import { ADD_PLAYER, STROKES, UNTAGGED_STROKE } from '@/domain/types';
import { GRADE_ORDER, GRADES, PHASE_BADGE, strokeHue } from '@/domain/grades';
import { Select, Tag, valueOf } from '@/lds';

/** The uppercase monospace label used for every section heading and stat. */
export function Mono({
  children,
  size = 10,
  color = 'var(--gray-500)',
  style,
  title,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  style?: CSSProperties;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        fontFamily: 'var(--th-mono)',
        fontSize: size,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/**
 * "N swings could not be read", in the header beside the clip count.
 *
 * The visible half of per-swing read isolation. Skipping a malformed document
 * instead of dropping the session is only an improvement if the reviewer is told
 * the session is short — otherwise 41 of 42 swings still presents as complete,
 * which is the same silence in a smaller size. The dirs and reasons go in the
 * `title`: a reviewer cannot act on them, but whoever owns the tree can.
 */
export function SkippedBanner({ skipped }: { skipped: SkippedSwing[] }) {
  if (skipped.length === 0) return null;
  return (
    <Mono
      color="var(--yellow-300)"
      title={skipped.map((s) => `${s.dir}: ${s.reason}`).join('\n')}
    >
      {skipped.length} {skipped.length === 1 ? 'swing' : 'swings'} could not be read
    </Mono>
  );
}

function PhaseBadge({ phase, size }: { phase: Phase; size: 'sm' | 'lg' }) {
  return (
    <span
      style={{
        position: 'absolute',
        left: size === 'sm' ? 5 : 10,
        top: size === 'sm' ? 5 : 9,
        padding: size === 'sm' ? '1px 5px' : '2px 7px',
        borderRadius: 3,
        background: PHASE_BADGE[phase],
        color: 'var(--gray-900)',
        fontFamily: 'var(--th-mono)',
        fontSize: size === 'sm' ? 8 : 9,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
      }}
    >
      {phase}
    </span>
  );
}

function PinCount({ count, size }: { count: number; size: number }) {
  return (
    <span
      style={{
        position: 'absolute',
        right: size > 15 ? 9 : 5,
        bottom: size > 15 ? 8 : 5,
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--gray-50)',
        color: 'var(--gray-900)',
        fontFamily: 'var(--th-mono)',
        fontSize: size > 15 ? 9 : 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {count}
    </span>
  );
}

export interface FrameTileProps {
  cell: Extract<Cell, { real: true }>;
  onClick: () => void;
  /** Overrides for the tile box — the compare grid, filmstrip and frame grid
   *  all use the same tile at three different sizes. */
  style?: CSSProperties;
  radius?: number;
  badgeSize?: 'sm' | 'lg';
  pinSize?: number;
  /** The frame grid labels its badge with the anchor phase, not the tile's own. */
  badgePhase?: Phase | null;
}

export function FrameTile({
  cell,
  onClick,
  style,
  radius = 5,
  badgeSize = 'sm',
  pinSize = 14,
  badgePhase,
}: FrameTileProps) {
  const phase = badgePhase === undefined ? cell.phase : badgePhase;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Frame ${cell.num} of clip ${cell.clip}`}
      aria-pressed={cell.selected}
      className="frame-still"
      style={{
        padding: 0,
        cursor: 'pointer',
        borderRadius: radius,
        appearance: 'none',
        ...style,
      }}
    >
      {cell.imageUrl !== undefined && (
        <img
          src={cell.imageUrl}
          alt=""
          role="presentation"
          loading="lazy"
          decoding="async"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // `contain`, not `cover`: the crop rectangle is already the framing
            // decision, made from the tracked player's pose boxes, and a tile
            // that re-crops it throws away whichever end of the body does not
            // fit. Landscape footage letterboxes against the tile's own
            // background instead of losing the head.
            objectFit: 'contain',
          }}
        />
      )}
      {phase !== null && <PhaseBadge phase={phase} size={badgeSize} />}
      <span
        style={{
          position: 'absolute',
          left: badgeSize === 'sm' ? 6 : 10,
          bottom: badgeSize === 'sm' ? 4 : 8,
          fontFamily: 'var(--th-mono)',
          fontSize: badgeSize === 'sm' ? 9 : 10,
          letterSpacing: '0.04em',
          color: 'rgba(250,249,233,0.62)',
        }}
      >
        {cell.num}
      </span>
      {cell.flagged && (
        <span
          title="Classifier is unsure about this frame"
          style={{
            position: 'absolute',
            right: 5,
            top: 5,
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--yellow-300)',
            boxShadow: '0 0 0 2px rgba(19,32,18,0.35)',
          }}
        />
      )}
      {cell.pinCount > 0 && <PinCount count={cell.pinCount} size={pinSize} />}
      {cell.selected && (
        <span
          style={{
            position: 'absolute',
            inset: 0,
            border: '2px solid var(--gray-900)',
            borderRadius: radius,
          }}
        />
      )}
    </button>
  );
}

/**
 * The three rating chips. The chip matching the clip's current grade shows in
 * its own hue at full strength; the rest sit grey and subtle, and clicking the
 * active one clears the rating.
 */
export function GradeChips({
  clip,
  onGrade,
  height = 20,
}: {
  clip: Clip;
  onGrade: (grade: Grade) => void;
  height?: number;
}) {
  return (
    <span className="grade-chips" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {GRADE_ORDER.map((g) => {
        const active = clip.grade === g;
        return (
          <span
            key={g}
            onClick={() => onGrade(g)}
            title={active ? 'Click to clear this rating' : `Rate ${GRADES[g].label.toLowerCase()}`}
            style={{ cursor: 'pointer' }}
          >
            <Tag
              size="sm"
              interactive
              hue={active ? GRADES[g].hue : 'gray'}
              emphasis={active ? 'strong' : 'subtle'}
              hint-size={`auto,${height}px`}
            >
              {GRADES[g].label}
            </Tag>
          </span>
        );
      })}
    </span>
  );
}

/** Stroke chip that swaps itself for a dropdown while `editing`. */
export function StrokeCell({
  clip,
  editing,
  onEdit,
  onChange,
  onStopEdit,
}: {
  clip: Clip;
  editing: boolean;
  onEdit: () => void;
  onChange: (stroke: Stroke) => void;
  onStopEdit: () => void;
}) {
  if (editing) {
    return (
      <span data-stroke-edit="1" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
        <Select
          size="sm"
          autoFocus
          aria-label="Stroke type"
          value={clip.stroke ?? ''}
          onChange={(e: Event) => onChange(valueOf(e) as Stroke)}
          onBlur={onStopEdit}
          options={[...STROKES]}
          hint-size="100%,28px"
        />
      </span>
    );
  }
  return (
    <span onClick={onEdit} title="Click to change stroke" style={{ cursor: 'pointer' }}>
      <Tag
        size="sm"
        interactive
        hue={strokeHue(clip.stroke)}
        emphasis="soft"
        hint-size="auto,20px"
        style={clip.stroke === null ? { opacity: 0.62 } : undefined}
      >
        {clip.stroke ?? UNTAGGED_STROKE}
      </Tag>
    </span>
  );
}

/** Player name that swaps itself for a dropdown while `editing`. */
export function PlayerCell({
  clip,
  editing,
  roster,
  onEdit,
  onChange,
  fontSize = 12,
}: {
  clip: Clip;
  editing: boolean;
  roster: string[];
  onEdit: () => void;
  onChange: (player: string) => void;
  fontSize?: number;
}) {
  if (editing) {
    return (
      <span data-player-edit="1" style={{ flex: 1, minWidth: 0, fontSize }}>
        <Select
          size="sm"
          autoFocus
          aria-label="Player"
          value={clip.player}
          onChange={(e: Event) => onChange(valueOf(e))}
          options={[...roster, ADD_PLAYER]}
          hint-size="100%,28px"
        />
      </span>
    );
  }
  return (
    <span
      onClick={onEdit}
      title="Click to change player"
      style={{
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationColor: 'var(--gray-300)',
        textUnderlineOffset: 3,
      }}
    >
      {clip.player}
    </span>
  );
}
