import { useCallback } from 'react';
import type { EtlSource } from '@/domain/etl-types';
import { Button, ICONS, Select, valueOf } from '@/lds';
import { useDismissEditors } from '@/hooks/useDismissEditors';
import { Mono } from './shared';

/** Bytes as the Finder would put it — sources here run 80 MB to 1.2 GB. */
const humanBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

/** `m:ss`, matching the per-clip duration the rows already show. */
const humanDuration = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The date the footage was shot, as far as the filesystem knows.
 *
 * Rendered from the ISO string by hand rather than through `toLocaleDateString`:
 * the ETL writes UTC, and letting the browser localise it would slide a late
 * afternoon session onto the previous day for anyone west of Greenwich.
 */
const humanDate = (iso: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
};

/**
 * The six facts about the source video, as the popover lists them.
 *
 * `width`/`height` are used unswapped: `probe.py` already resolved the rotation
 * mess — `coded_size()` is the one that swaps, for callers reading raw frames —
 * so the pair on the source block is the played orientation. Swapping again
 * printed portrait IMG_0304 as "1920x1080".
 */
function specRows(source: EtlSource): Array<[string, string]> {
  return [
    ['File', source.name],
    ...(source.modified === undefined
      ? []
      : ([['Shot', humanDate(source.modified)]] as Array<[string, string]>)),
    ['Size', humanBytes(source.bytes)],
    ['Length', humanDuration(source.duration_ms)],
    ['Frame', `${source.width}x${source.height}${source.rotation === 0 ? '' : ' ↻'}`],
    ['Rate', `${source.fps.toFixed(2).replace(/\.?0+$/, '')} fps${source.vfr ? ' (vfr)' : ''}`],
  ];
}

/**
 * Which source video the grid is showing, in the header.
 *
 * The spec sits behind an info button rather than on the page: it answers
 * "which afternoon is this, and how was it shot" — asked once when you sit
 * down, not continuously while reviewing — and a permanent six-row block spent
 * a sixth of the sidebar on it.
 */
export function SourcePicker({
  session,
  sessions,
  source,
  open,
  onOpenChange,
  onSession,
  compact = false,
}: {
  session: string;
  sessions: string[];
  source: EtlSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSession: (session: string) => void;
  /** Drop the label and the divider — a phone header has no room for either. */
  compact?: boolean;
}) {
  // Same capture-phase dismissal the inline editors use, so a click anywhere
  // outside closes the popover; `[data-source-meta]` is the guard that keeps a
  // click on the button itself from closing what it just opened.
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissEditors(open, close);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        ...(compact ? {} : { paddingLeft: 16, borderLeft: '1px solid var(--gray-300)' }),
        flex: 'none',
      }}
    >
      {/* The select shows the file name; the word "Source" above it is a
          caption for something already captioned. */}
      {!compact && (
        <Mono size={10} style={{ letterSpacing: '0.08em', color: 'var(--gray-500)' }}>
          Source
        </Mono>
      )}
      {/* One session in the tree is not a choice, so it reads as a label. */}
      {sessions.length > 1 ? (
        <span style={{ width: compact ? 140 : 180 }}>
          <Select
            size="sm"
            aria-label="Source video"
            value={session}
            onChange={(e: Event) => onSession(valueOf(e))}
            options={sessions}
            hint-size="100%,32px"
          />
        </span>
      ) : (
        <Mono size={11} style={{ textTransform: 'none', letterSpacing: '0.04em' }}>
          {session}
        </Mono>
      )}

      {source !== null && (
        <span data-source-meta="1" style={{ position: 'relative' }}>
          <span
            onClick={() => onOpenChange(!open)}
            title="Source video details"
            style={{ cursor: 'pointer' }}
          >
            <Button
              variant="tertiary"
              size="sm"
              iconOnly
              iconStart="info"
              aria-label="Source details"
              iconHref={ICONS}
              hint-size="28px,28px"
            />
          </span>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: 34,
                left: -120,
                zIndex: 20,
                width: 268,
                padding: '14px 16px',
                borderRadius: 8,
                background: 'var(--gray-50)',
                border: '1px solid var(--gray-300)',
                boxShadow: '0 8px 24px rgba(19,32,18,0.12)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {specRows(source).map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <Mono size={11} style={{ letterSpacing: '0.07em', color: 'var(--gray-500)' }}>
                    {label}
                  </Mono>
                  <Mono
                    size={11}
                    title={value}
                    style={{ textTransform: 'none', color: 'var(--gray-800)' }}
                  >
                    {value}
                  </Mono>
                </div>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
