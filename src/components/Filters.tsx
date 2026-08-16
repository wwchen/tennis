import type { Dispatch } from 'react';
import type { Action, Ui } from '@/state/store';
import type { Stats } from '@/lib/selectors';
import type { Phase } from '@/domain/types';
import { ALL_PLAYERS, ALL_RATINGS, ALL_STROKES } from '@/domain/types';
import { GRADE_ORDER, GRADES } from '@/domain/grades';
import { checkedOf, ICONS, SegmentedControl, Select, Toggle, valueOf } from '@/lds';
import { Mono } from './shared';

const ANCHOR_OPTIONS = [
  { value: 'setup', label: 'Setup' },
  { value: 'contact', label: 'Contact' },
  { value: 'finish', label: 'Finish' },
];

export function Filters({
  ui,
  stats,
  players,
  strokes,
  dispatch,
}: {
  ui: Ui;
  stats: Stats;
  players: string[];
  strokes: string[];
  dispatch: Dispatch<Action>;
}) {
  const anchorHint = ui.onlyAnchor
    ? `One column: the ${ui.anchor} frame of each clip, stacked for comparison.`
    : `Rows shift so every clip’s ${ui.anchor} frame sits in the same column.`;

  return (
    <aside
      style={{
        width: 268,
        flex: 'none',
        overflowY: 'auto',
        padding: '20px 18px 40px',
        background: 'var(--gray-50)',
        borderRight: '1px solid var(--gray-300)',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Mono style={{ letterSpacing: '0.09em' }}>Filter</Mono>
        <Select
          label="Player"
          value={ui.playerFilter}
          onChange={(e: Event) => dispatch({ type: 'setPlayerFilter', value: valueOf(e) })}
          options={[ALL_PLAYERS, ...players]}
          hint-size="100%,60px"
        />
        <Select
          label="Stroke"
          value={ui.strokeFilter}
          onChange={(e: Event) => dispatch({ type: 'setStrokeFilter', value: valueOf(e) })}
          options={[ALL_STROKES, ...strokes]}
          hint-size="100%,60px"
        />
        <Select
          label="Rating"
          value={ui.gradeFilter}
          onChange={(e: Event) => dispatch({ type: 'setGradeFilter', value: valueOf(e) })}
          options={[ALL_RATINGS, ...GRADE_ORDER.map((g) => GRADES[g].label), GRADES.none.label]}
          hint-size="100%,60px"
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Mono style={{ letterSpacing: '0.09em' }}>Align frame</Mono>
        <SegmentedControl
          label="Align frame"
          size="sm"
          iconHref={ICONS}
          value={ui.anchor}
          onChange={(value: string) => dispatch({ type: 'setAnchor', anchor: value as Phase })}
          options={ANCHOR_OPTIONS}
          hint-size="100%,32px"
        />
        <div style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--gray-600)' }}>{anchorHint}</div>
        <Toggle
          label="Show only this frame"
          checked={ui.onlyAnchor}
          onChange={(e: Event) => dispatch({ type: 'setOnlyAnchor', value: checkedOf(e) })}
          hint-size="100%,24px"
        />
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          paddingTop: 4,
          borderTop: '1px solid var(--gray-200)',
        }}
      >
        <Toggle
          label="Unchecked auto-tags only"
          checked={ui.lowOnly}
          onChange={(e: Event) => dispatch({ type: 'setLowOnly', value: checkedOf(e) })}
          hint-size="100%,24px"
        />
        <Toggle
          label="Show removed clips"
          checked={ui.showRejected}
          onChange={(e: Event) => dispatch({ type: 'setShowRejected', value: checkedOf(e) })}
          hint-size="100%,24px"
        />
      </div>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Mono size={10} style={{ letterSpacing: '0.06em' }}>
          {stats.visible} of {stats.total} clips shown
        </Mono>
        <Mono size={10} style={{ letterSpacing: '0.06em' }}>
          {stats.frames} frames
        </Mono>
        <Mono size={10} style={{ letterSpacing: '0.06em' }}>
          {stats.rated} of {stats.total} rated
        </Mono>
        <Mono size={10} style={{ letterSpacing: '0.06em' }}>
          {stats.removed} removed
        </Mono>
      </div>
    </aside>
  );
}
