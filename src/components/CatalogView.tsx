import type { Dispatch } from 'react';
import type { Action, Ui } from '@/state/store';
import { commentsOn } from '@/lib/selectors';
import type { Clip, Comment, Phase } from '@/domain/types';
import type { EtlSource } from '@/domain/etl-types';
import { gradeOf, PHASES } from '@/domain/grades';
import { clipLength, shortId, sourceEnd, sourceStart } from '@/domain/types';
import { phaseFrame } from '@/domain/window';
import { Button, ICONS, Icon, Tag } from '@/lds';
import { Mono } from './shared';

function CatalogCard({
  clip,
  comments,
  ui,
  mobile,
  aspect,
  dispatch,
}: {
  clip: Clip;
  comments: Comment[];
  ui: Ui;
  mobile: boolean;
  /**
   * The source video's shape, as `width / height`.
   *
   * The card follows the footage rather than assuming one orientation. The
   * stills are full frames now, so a landscape session in a portrait card is
   * cropped to its middle third — which on IMG_0309 cut the player out of his
   * own clip entirely, leaving three cards of empty court.
   */
  aspect: number;
  dispatch: Dispatch<Action>;
}) {
  const grade = gradeOf(clip.grade);
  const commentCount = commentsOn(comments, clip.id).length;
  const selected = ui.sel?.clip === clip.id;

  const frameFor = (phase: Phase) => phaseFrame(clip, phase);

  const playingInline = ui.inlineClip === clip.id;
  // Clicking setup/contact/finish selects that frame, and the card then shows
  // it: the strip is a way to look through the swing, so the answer belongs on
  // the card being looked at rather than in a panel somewhere else.
  const selectedFrame =
    ui.sel?.clip === clip.id ? clip.frames.find((f) => f.i === ui.sel?.frame) : undefined;
  const cover = selectedFrame ?? frameFor('contact');

  return (
    <div
      className={clip.rejected ? 'is-removed' : undefined}
      style={{
        background: 'var(--gray-50)',
        // Marked the same way as the compare row, in the vocabulary a card has:
        // the border darkens and a 1px ring goes round it, rather than a fill
        // that would fight the thumbnail behind it.
        border: `1px solid ${selected ? 'var(--gray-400)' : 'var(--gray-300)'}`,
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: selected ? '0 0 0 1px var(--gray-400)' : 'none',
      }}
    >
      <div
        /*
          The picture is the play button. Clicking a frame to watch it move is
          the obvious gesture, and it used to open the detail view instead —
          navigating away from the grid to answer a question the card can
          answer in place. The clip id below still opens the detail view.
        */
        onClick={() => dispatch({ type: 'playInline', clip: playingInline ? null : clip.id })}
        title={playingInline ? 'Stop' : 'Play clip'}
        className="frame-still"
        /* The card matches the still's own shape, so `cover` crops nothing. */
        style={{ aspectRatio: String(aspect), cursor: 'pointer', border: 'none' }}
      >
        {/* The card's picture. Its absence is why every catalog tile was an
            empty gradient: this view built cells and never gave them a URL. */}
        {playingInline && clip.videoUrl !== undefined ? (
          /*
            The clip, in the card. The card is already the size of a player, so
            opening a side panel to watch something you can see is a detour.
            `stopPropagation` because the card behind this opens the clip.
          */
          <video
            key={clip.id}
            src={clip.videoUrl}
            autoPlay
            loop
            playsInline
            controls
            // `ffmpeg -an`: the clips have no audio track at all, but Chrome
            // still refuses to autoplay without the attribute, so the card
            // rendered a paused first frame with a play button on it.
            muted
            // Click the video to stop it, the same as clicking the frame that
            // started it. No `onEnded`: `loop` means it never ends, and a
            // three-second swing is worth seeing several times.
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'playInline', clip: null });
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              background: 'var(--green-900, #0d1a0e)',
            }}
          />
        ) : (
          cover?.imageUrl !== undefined && (
          <img
            src={cover.imageUrl}
            alt=""
            role="presentation"
            loading="lazy"
            decoding="async"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
          )
        )}
        <span
          style={{
            position: 'absolute',
            left: 12,
            top: 12,
            fontFamily: 'var(--th-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: 'rgba(250,249,233,0.75)',
            cursor: 'pointer',
            // Over a bright ceiling the label washed out; the shadow keeps it
            // readable whatever the still behind it happens to be.
            textShadow: '0 1px 3px rgba(19,32,18,0.8)',
          }}
          title={`${clip.id} — open clip detail`}
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: 'openDetail', clip: clip.id });
          }}
        >
          {shortId(clip.id)}
        </span>
        <span style={{ position: 'absolute', right: 12, top: 10 }}>
          <Tag size="sm" hue={grade.hue} emphasis="strong" hint-size="auto,20px">
            {grade.label}
          </Tag>
        </span>
        {/*
          Plays in the inspector, like the compare row's button. `stopPropagation`
          because the card behind it opens the clip: without it, one click both
          starts playback and navigates away from the panel playing it.
        */}
        {clip.videoUrl !== undefined && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Play clip ${clip.id}`}
            title="Play clip"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'playInline', clip: playingInline ? null : clip.id });
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              e.stopPropagation();
              dispatch({ type: 'playInline', clip: playingInline ? null : clip.id });
            }}
            style={{
              position: 'absolute',
              left: 10,
              bottom: 10,
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: 'rgba(250,249,233,0.9)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Icon name="play-fill" size={14} href={ICONS} hint-size="14px,14px" />
          </span>
        )}
      </div>

      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          {/* Player and stroke used to sit here; both were identical on every
              card. The timestamp is what distinguishes them. */}
          {/* `nowrap`: a narrow card broke the range into two half-timestamps. */}
          <Mono
            size={12}
            title="Where this clip sits in the source video"
            style={{ textTransform: 'none', whiteSpace: 'nowrap' }}
          >
            {`${sourceStart(clip)}–${sourceEnd(clip)}`}
          </Mono>
          <Mono
            size={12}
            title="Clip length"
            style={{
              textTransform: 'none',
              color: 'var(--gray-500)',
              whiteSpace: 'nowrap',
              flex: 'none',
            }}
          >
            {clipLength(clip)}
          </Mono>
        </div>

        {/* Setup / contact / finish shortcut strip — jumps the inspector
            straight to that phase's frame without opening the clip. */}
        <div style={{ display: 'flex', gap: 4 }}>
          {PHASES.map((phase) => {
            const frame = frameFor(phase);
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
                  aspectRatio: String(aspect),
                  borderRadius: 4,
                  outline:
                    frame !== undefined && selectedFrame?.i === frame.i
                      ? '2px solid var(--gray-900)'
                      : 'none',
                  outlineOffset: -2,
                  padding: 0,
                  cursor: frame ? 'pointer' : 'default',
                  appearance: 'none',
                }}
              >
                {frame?.imageUrl !== undefined && (
                  <img
                    src={frame.imageUrl}
                    alt=""
                    role="presentation"
                    loading="lazy"
                    decoding="async"
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                )}
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
          {/* Icon-only on a phone: the label wrapped to three lines. */}
          <span
            onClick={() => dispatch({ type: 'toggleReject', clip: clip.id })}
            style={{ cursor: 'pointer', flex: 'none' }}
            title={clip.rejected ? 'Restore this clip' : 'Remove: not a swing'}
          >
            <Button
              variant="tertiary"
              size="sm"
              hue={clip.rejected ? 'green' : 'red'}
              iconOnly={mobile}
              iconStart={clip.rejected ? 'history' : 'trash'}
              aria-label={clip.rejected ? `Restore clip ${clip.id}` : `Remove clip ${clip.id}`}
              iconHref={ICONS}
              hint-size={mobile ? '28px,28px' : 'auto,28px'}
            >
              {mobile ? undefined : clip.rejected ? 'Restore' : 'Remove'}
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
  ui,
  mobile,
  source,
  dispatch,
}: {
  clips: Clip[];
  comments: Comment[];
  mobile: boolean;
  source: EtlSource | null;
  ui: Ui;
  dispatch: Dispatch<Action>;
}) {
  // `probe.py` already resolved rotation, so these are the played dimensions.
  // 3/4 is the fallback for a tree with no source block — a partial render, or
  // the seed — and matches the portrait footage this started with.
  const aspect =
    source === null || !source.width || !source.height
      ? 3 / 4
      : source.width / source.height;

  return (
    <div
      className="catalog-grid"
      style={{
        padding: '22px 24px 60px',
        display: 'grid',
        gap: 16,
      }}
    >
      {clips.map((clip) => (
        <CatalogCard
          key={clip.id}
          clip={clip}
          comments={comments}
          ui={ui}
          mobile={mobile}
          aspect={aspect}
          dispatch={dispatch}
        />
      ))}
    </div>
  );
}
