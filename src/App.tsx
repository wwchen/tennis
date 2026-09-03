import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useShotLab } from '@/state/store';
import { useDismissEditors } from '@/hooks/useDismissEditors';
import { useIsMobile } from '@/hooks/useIsMobile';
import { buildCompare, pinsFor, rosterOf, statsOf, strokesOf, visibleClips } from '@/lib/selectors';
import { Avatar, Button, ICONS, SegmentedControl, TextField, valueOf } from '@/lds';
import type { View } from '@/domain/types';
import { Mono, SkippedBanner } from '@/components/shared';
import { Filters } from '@/components/Filters';
import { SourcePicker } from '@/components/SourcePicker';
import { CompareTable, FrameGrid } from '@/components/CompareView';
import { CatalogView } from '@/components/CatalogView';
import { DetailView } from '@/components/DetailView';
import { Inspector } from '@/components/Inspector';
import { KeyframeReview } from '@/components/KeyframeReview';

const VIEW_OPTIONS = [
  { value: 'keyframes', label: 'Keyframes', icon: 'play' },
  { value: 'compare', label: 'Compare', icon: 'list' },
  { value: 'catalog', label: 'Catalog', icon: 'grid' },
];

export default function App() {
  const { state, dispatch, switchSession } = useShotLab();
  const { doc, ui } = state;
  const mobile = useIsMobile();
  // On a phone the app opens in the catalog: the compare grid is nine columns
  // of a shared timeline, which is a wide thing by nature and unreadable at
  // 390px. Once only — a reviewer who then picks Compare keeps it.
  const wentMobile = useRef(false);
  useEffect(() => {
    if (!mobile || wentMobile.current) return;
    wentMobile.current = true;
    dispatch({ type: 'setView', view: 'catalog' });
  }, [mobile, dispatch]);

  // Which flag the menu button toggles depends on which layout is on screen;
  // see `Ui.mobileFilters` for why they are separate.
  const filtersVisible = mobile ? ui.mobileFilters : ui.filtersOpen;
  const toggleFilters = () =>
    dispatch({ type: mobile ? 'toggleMobileFilters' : 'toggleFilters' });

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

  if (ui.view === 'keyframes') {
    return (
      <div style={{ height: '100vh', background: 'var(--gray-100)' }}>
        <KeyframeReview
          clips={doc.clips}
          {...(state.proxy === null || state.session === null
            ? {}
            : { proxyUrl: `/api/media/${state.session}/${state.proxy.file}` })}
          // The SOURCE's duration, not the proxy's: they differ by a frame or
          // two, and every swing timestamp was measured against the source.
          durationMs={state.source?.duration_ms ?? state.proxy?.duration_ms ?? 0}
          probe={state.source}
          settings={state.settings}
          detection={state.detection}
          session={state.session ?? '—'}
          sessions={state.playable}
          onSession={switchSession}
        />
      </div>
    );
  }

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
        className="app-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          rowGap: 8,
          minHeight: 60,
          flex: 'none',
          background: 'var(--gray-50)',
          borderBottom: '1px solid var(--gray-300)',
        }}
      >
        <span
          onClick={toggleFilters}
          title={filtersVisible ? 'Hide filters' : 'Show filters'}
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
        {/*
          The wordmark is the first thing to go on a phone. It is branding on a
          tool the reviewer already knows they opened, and at 390px it cost a
          row of a header that was taking four of them — about half the screen
          before a single clip.
        */}
        {!mobile && (
          <div className="wordmark-block" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: 'var(--th-display)', fontSize: 23, letterSpacing: '-0.01em' }}>
              Shot Lab
            </span>
            <Mono>{stats.total} clips</Mono>
          </div>
        )}
        {state.session !== null && (
          <SourcePicker
            session={state.session}
            sessions={state.sessions}
            source={state.source}
            open={ui.sourceMetaOpen}
            onOpenChange={(open) => dispatch({ type: 'setSourceMetaOpen', value: open })}
            onSession={switchSession}
            compact={mobile}
          />
        )}
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
        {/*
          Export and the avatar are desktop furniture: exporting a session is
          not something done one-handed on a court, and the avatar identifies a
          reviewer the app has no sign-in for. The unrated count survives —
          it is the one number that says how much work is left.
        */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Mono>{stats.unrated} unrated</Mono>
          {mobile ? null : (
            <>
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
            </>
          )}
        </div>
      </header>

      <div className="app-body" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Scrim: the drawer floats over the clips, so there has to be
            somewhere to tap that means "put it away". */}
        {mobile && ui.mobileFilters && (
          <div
            onClick={toggleFilters}
            style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(19,32,18,0.4)' }}
          />
        )}
        {filtersVisible && (
          <Filters
            ui={ui}
            stats={stats}
            players={roster}
            strokes={strokes}
            mobile={mobile}
            dispatch={dispatch}
          />
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
                mobile={mobile}
                source={state.source}
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

        {/*
          No inspector in the catalog. There, a card IS the inspector: it plays
          its own clip and shows whichever frame you pick, so a panel repeating
          that beside it takes a third of the width to say the same thing twice.
          The selection still matters — it is what the card renders — it just
          has nowhere else it needs to be shown.
        */}
        {/* No inspector in the catalog on a desktop, and on a phone none until
            a frame is picked — an empty sheet would be a permanent band across
            the bottom of a small screen saying nothing. */}
        {ui.view !== 'catalog' && (!mobile || selFrame !== undefined) && (
          <Inspector
            playing={ui.inspectorPlaying}
            mobile={mobile}
            sheetFull={ui.sheetFull}
            clip={selClip}
            frame={selFrame}
            pins={pins}
            draft={ui.draft}
            dispatch={dispatch}
          />
        )}
      </div>
    </div>
  );
}
