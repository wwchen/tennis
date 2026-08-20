import { useCallback, useMemo } from 'react';
import { useShotLab } from '@/state/store';
import { useDismissEditors } from '@/hooks/useDismissEditors';
import { buildCompare, pinsFor, rosterOf, statsOf, strokesOf, visibleClips } from '@/lib/selectors';
import { Avatar, Button, ICONS, SegmentedControl, TextField, valueOf } from '@/lds';
import type { View } from '@/domain/types';
import { Mono, SkippedBanner } from '@/components/shared';
import { Filters } from '@/components/Filters';
import { CompareTable, FrameGrid } from '@/components/CompareView';
import { CatalogView } from '@/components/CatalogView';
import { DetailView } from '@/components/DetailView';
import { Inspector } from '@/components/Inspector';

const VIEW_OPTIONS = [
  { value: 'compare', label: 'Compare', icon: 'list' },
  { value: 'catalog', label: 'Catalog', icon: 'grid' },
];

export default function App() {
  const { state, dispatch } = useShotLab();
  const { doc, ui } = state;

  const dismissEditors = useCallback(() => dispatch({ type: 'stopEditing' }), [dispatch]);
  useDismissEditors(ui.editingStroke !== null || ui.editingPlayer !== null, dismissEditors);

  const clips = useMemo(() => visibleClips(doc, ui), [doc, ui]);
  const stats = useMemo(() => statsOf(doc, clips), [doc, clips]);
  const roster = useMemo(() => rosterOf(doc), [doc]);
  const strokes = useMemo(() => strokesOf(doc), [doc]);
  const { rows, colLabels } = useMemo(
    () => buildCompare(clips, ui.anchor, doc.comments, ui.sel),
    [clips, ui.anchor, doc.comments, ui.sel],
  );

  const selClip = doc.clips.find((c) => c.id === ui.sel?.clip);
  const selFrame = selClip && ui.sel ? selClip.frames[ui.sel.frame] : undefined;
  const detailClip = doc.clips.find((c) => c.id === ui.detail);
  const pins = selClip && selFrame ? pinsFor(doc.comments, selClip.id, selFrame.i) : [];

  const showDetail = ui.view === 'detail' && detailClip !== undefined;
  const shared = { roster, comments: doc.comments, ui, dispatch };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--gray-100)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          rowGap: 8,
          gap: 20,
          padding: '0 20px',
          minHeight: 60,
          flex: 'none',
          background: 'var(--gray-50)',
          borderBottom: '1px solid var(--gray-300)',
        }}
      >
        <span
          onClick={() => dispatch({ type: 'toggleFilters' })}
          title={ui.filtersOpen ? 'Hide filters' : 'Show filters'}
          style={{ cursor: 'pointer', flex: 'none' }}
        >
          <Button
            variant="tertiary"
            size="sm"
            iconOnly
            iconStart="menu"
            aria-label="Toggle filters"
            iconHref={ICONS}
            hint-size="28px,28px"
          />
        </span>
        <div
          style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 190, flex: 'none' }}
        >
          <span style={{ fontFamily: 'var(--th-display)', fontSize: 23, letterSpacing: '-0.01em' }}>
            Shot Lab
          </span>
          <Mono>{stats.total} clips</Mono>
        </div>
        <SkippedBanner skipped={state.skipped} />
        <SegmentedControl
          label="View"
          size="sm"
          iconHref={ICONS}
          value={ui.view === 'detail' ? 'compare' : ui.view}
          onChange={(value: string) => dispatch({ type: 'setView', view: value as View })}
          options={VIEW_OPTIONS}
          hint-size="220px,32px"
        />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Mono>{stats.unrated} unrated</Mono>
          <Button
            variant="secondary"
            size="sm"
            iconStart="download"
            iconHref={ICONS}
            hint-size="auto,32px"
          >
            Export session
          </Button>
          <Avatar name="Coach Ana" size="sm" hint-size="28px,28px" />
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {ui.filtersOpen && (
          <Filters ui={ui} stats={stats} players={roster} strokes={strokes} dispatch={dispatch} />
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {stats.removed > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 24px',
                background: 'var(--gray-200)',
                borderBottom: '1px solid var(--gray-300)',
              }}
            >
              <Mono color="var(--gray-600)">{stats.removed} hidden</Mono>
              <span onClick={() => dispatch({ type: 'undoRemove' })} style={{ cursor: 'pointer' }}>
                <Button
                  variant="tertiary"
                  size="sm"
                  iconStart="history"
                  iconHref={ICONS}
                  hint-size="auto,28px"
                >
                  {doc.removedStack.length > 0 ? `Undo ${doc.removedStack.at(-1)}` : 'Undo'}
                </Button>
              </span>
              <div style={{ flex: 1 }} />
              <span
                onClick={() => dispatch({ type: 'toggleShowRemoved' })}
                style={{ cursor: 'pointer' }}
              >
                <Button variant="tertiary" size="sm" hint-size="auto,28px">
                  {ui.showRejected ? 'Hide removed' : 'Show removed'}
                </Button>
              </span>
            </div>
          )}

          {ui.addingPlayer && (
            <div
              data-player-edit="1"
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 10,
                padding: '14px 24px',
                background: 'var(--gray-50)',
                borderBottom: '1px solid var(--gray-300)',
              }}
            >
              <span style={{ flex: 1, maxWidth: 280 }}>
                <TextField
                  label="New player"
                  autoFocus
                  placeholder="Name"
                  value={ui.newPlayer}
                  onChange={(e: Event) => dispatch({ type: 'setNewPlayer', value: valueOf(e) })}
                  hint-size="100%,60px"
                />
              </span>
              <span
                onClick={() => dispatch({ type: 'commitNewPlayer' })}
                style={{ cursor: 'pointer' }}
              >
                <Button variant="primary" size="sm" hint-size="auto,32px">
                  Add
                </Button>
              </span>
              <span
                onClick={() => dispatch({ type: 'cancelNewPlayer' })}
                style={{ cursor: 'pointer' }}
              >
                <Button variant="tertiary" size="sm" hint-size="auto,32px">
                  Cancel
                </Button>
              </span>
            </div>
          )}

          <main style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
            {showDetail && (
              <DetailView
                clip={detailClip}
                selectedFrame={ui.sel?.frame ?? null}
                comments={doc.comments}
                roster={roster}
                playing={ui.playing}
                dispatch={dispatch}
              />
            )}
            {!showDetail && ui.view === 'catalog' && (
              <CatalogView
                clips={clips}
                comments={doc.comments}
                roster={roster}
                ui={ui}
                dispatch={dispatch}
              />
            )}
            {!showDetail && ui.view !== 'catalog' && ui.onlyAnchor && (
              <FrameGrid
                clips={clips}
                anchor={ui.anchor}
                comments={doc.comments}
                ui={ui}
                dispatch={dispatch}
              />
            )}
            {!showDetail && ui.view !== 'catalog' && !ui.onlyAnchor && (
              <CompareTable rows={rows} colLabels={colLabels} anchor={ui.anchor} {...shared} />
            )}
          </main>
        </div>

        <Inspector clip={selClip} frame={selFrame} pins={pins} draft={ui.draft} dispatch={dispatch} />
      </div>
    </div>
  );
}
