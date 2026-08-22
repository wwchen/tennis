import type { Dispatch } from 'react';
import type { Action, Ui } from '@/state/store';
import type { Stats } from '@/lib/selectors';
import type { Phase } from '@/domain/types';
import { ALL_PLAYERS, ALL_RATINGS, ALL_STROKES, SUSPECT_SPEED } from '@/domain/types';
import { GRADE_ORDER, GRADES } from '@/domain/grades';
import { Button, checkedOf, ICONS, SegmentedControl, Select, Toggle, valueOf } from '@/lds';
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
  mobile,
  dispatch,
}: {
  ui: Ui;
  stats: Stats;
  players: string[];
  strokes: string[];
  /** Render as a drawer over the content rather than a column beside it. */
  mobile: boolean;
  dispatch: Dispatch<Action>;
}) {
  const anchorHint = ui.onlyAnchor
    ? `One column: the ${ui.anchor} frame of each clip, stacked for comparison.`
    : `Rows shift so every clip’s ${ui.anchor} frame sits in the same column.`;

  return (
    <aside
      className="filters-panel"
      style={
        mobile
          ? {
              // Over the clips, not beside them: 268px of a 390px screen is
              // most of it, and the filters are a thing you open, change and
              // close rather than watch.
              position: 'fixed',
              zIndex: 31,
              top: 0,
              bottom: 0,
              left: 0,
              width: 'min(300px,86vw)',
              overflowY: 'auto',
              padding: '16px 16px 32px',
              background: 'var(--gray-50)',
              borderRight: '1px solid var(--gray-300)',
              boxShadow: '0 0 40px rgba(19,32,18,0.22)',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }
          : {
              flex: 'none',
              overflowY: 'auto',
              padding: '20px 18px 40px',
              background: 'var(--gray-50)',
              borderRight: '1px solid var(--gray-300)',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }
      }
    >
      {/* A drawer needs its own way out; the menu button that opened it is
          behind the scrim. */}
      {mobile && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Mono style={{ letterSpacing: '0.09em' }}>Filters</Mono>
          <span
            onClick={() => dispatch({ type: 'toggleMobileFilters' })}
            style={{ cursor: 'pointer' }}
          >
            <Button
              variant="tertiary"
              size="sm"
              iconOnly
              iconStart="close"
              aria-label="Close filters"
              iconHref={ICONS}
              hint-size="28px,28px"
            />
          </span>
        </div>
      )}
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
          label="Likely not a swing"
          checked={ui.suspectOnly}
          onChange={(e: Event) => dispatch({ type: 'setSuspectOnly', value: checkedOf(e) })}
          hint-size="100%,24px"
        />
        <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--gray-600)' }}>
          Wrist slower than {SUSPECT_SPEED} torso-heights/s <em>and</em> still at the body midline
          at contact — a body standing still. About 18% of a session; check the clip before
          removing.
        </div>
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
