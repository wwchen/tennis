import type { CSSProperties, ReactNode } from 'react';
import type { EtlSource } from '@/domain/etl-types';
import type { Clip, ObjectBox } from '@/domain/types';
import {
  BALL_IN_FLIGHT,
  SUSPECT_ARM,
  SUSPECT_SPEED,
  isSuspect,
  sourceRange,
} from '@/domain/types';
import { Tag } from '@/lds';
import { Mono } from './shared';

/**
 * Everything the probe and the detector know about one swing, in the right rail.
 *
 * The review UI is otherwise built out of the pipeline's *conclusions* — a
 * rejected flag, a grade, a stroke chip — and those are deliberately lossy. This
 * panel is the other half: the numbers those conclusions were drawn from, so a
 * reviewer disagreeing with a call can see what the call was made on. It is a
 * read-only surface by design; every editable version of these values already
 * has a control somewhere else, and duplicating them here would give one field
 * two owners.
 *
 * Sized for a ~316px rail, which is what shapes the layout: label-left /
 * value-right rows rather than a table, no horizontal rules inside a group, and
 * values that wrap rather than truncate — a truncated `audio_onset+pose_verify`
 * is worse than a wrapped one, because the interesting half is at the end.
 */

/** What a field says when the pipeline measured nothing there. */
const NOT_MEASURED = 'not measured';

/**
 * `0:26.006` — the app's `m:ss` clock, plus milliseconds.
 *
 * The milliseconds are the point. Contact is a single frame at 60fps, so a
 * whole-second clock rounds away exactly the precision that makes the number
 * worth showing: two swings 400ms apart both read "0:26", and the reviewer
 * checking whether the detector timed this one badly learns nothing.
 */
const stamp = (ms: number): string => {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const millis = String(Math.max(0, Math.round(ms)) % 1000).padStart(3, '0');
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${millis}`;
};

/** `+1.5s` / `-0.3s` — signed, because the sign is the whole reading. */
const signedSeconds = (ms: number): string => {
  const s = ms / 1000;
  // Trailing zeros stripped, dot included: `+1.50s` implies a precision the
  // window arithmetic does not have, and `+3.s` is not a number.
  const magnitude = s.toFixed(2).replace(/\.?0+$/, '');
  return `${s >= 0 ? '+' : ''}${magnitude}s`;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        paddingTop: 12,
        borderTop: '1px solid var(--gray-200)',
      }}
    >
      <Mono style={{ letterSpacing: '0.09em', paddingBottom: 2 }}>{title}</Mono>
      {children}
    </section>
  );
}

/**
 * One label/value pair.
 *
 * `value` takes a node rather than a string so a row can carry a Tag, and the
 * absent case is a `tone` rather than a separate component: "not measured" has
 * to sit in the same column as a number so a reviewer scanning the rail sees one
 * list with gaps in it, not two interleaved lists.
 */
function Row({
  label,
  value,
  absent = false,
  title,
}: {
  label: string;
  value: ReactNode;
  /** Render greyed: this is a hole in the data, not a value. */
  absent?: boolean;
  title?: string;
}) {
  const style: CSSProperties = {
    fontFamily: 'var(--th-mono)',
    fontSize: 11,
    lineHeight: 1.35,
    textAlign: 'right',
    minWidth: 0,
    // The rail is narrow and these are unbreakable tokens (`audio_onset+…`,
    // `false_positive`); wrapping mid-token beats a clipped one.
    overflowWrap: 'anywhere',
    color: absent ? 'var(--gray-500)' : 'var(--gray-900)',
  };
  return (
    <div
      title={title}
      style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}
    >
      <Mono size={9} style={{ flex: 'none' }}>
        {label}
      </Mono>
      <span style={style}>{value}</span>
    </div>
  );
}

/** Prose under a group, explaining a value that a number alone would misreport. */
function Note({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.45,
        color: 'var(--gray-500)',
        textWrap: 'pretty',
        paddingTop: 2,
      }}
    >
      {children}
    </div>
  );
}

function Detector({ clip }: { clip: Clip }) {
  const det = clip.detection;
  const contactMs = clip.contactMs;

  return (
    <Section title="Detector">
      {det === undefined ? (
        <Row label="method" value="no detector" absent />
      ) : (
        <>
          <Row label="method" value={det.method} title="How this swing was found" />
          <Row
            label="verified"
            title={
              det.verified
                ? "The verifier's pose checks passed"
                : 'The verifier rejected this; a human verdict can still override it'
            }
            value={
              <Tag
                size="sm"
                hue={det.verified ? 'green' : 'red'}
                emphasis="soft"
                hint-size="auto,18px"
              >
                {det.verified ? 'yes' : 'no'}
              </Tag>
            }
          />
          <Row
            label="onset peak"
            title="Audio onset strength, in noise-floor multiples"
            absent={det.onsetPeak === null}
            value={det.onsetPeak === null ? NOT_MEASURED : det.onsetPeak.toFixed(2)}
          />
          <Row
            label="reject reason"
            absent={det.rejectReason === null}
            value={det.rejectReason ?? 'none'}
          />
        </>
      )}

      {contactMs !== undefined && (
        <Row label="contact at" value={stamp(contactMs)} title="In source-video time" />
      )}
      {/*
        Where contact sits inside the window the detector cut around it. This is
        the one arithmetic result on the panel, and it earns its place: a swing
        whose contact has drifted to an edge of its own window is one the
        detector timed badly, and neither raw number says so on its own.
      */}
      {contactMs !== undefined && clip.sourceStartMs !== undefined && (
        <Row
          label="into window"
          value={signedSeconds(contactMs - clip.sourceStartMs)}
          title="Contact's offset from the start of the cut window"
        />
      )}
      {det?.onsetPeak === null && (
        <Note>
          No onset peak: this swing was found from pose, not from an audio spike, so there
          is no peak to report.
        </Note>
      )}
    </Section>
  );
}

function Measured({ clip }: { clip: Clip }) {
  const m = clip.measurements;
  // Both halves come from `isSuspect`, not from a second copy of the rule — the
  // filter in the catalog and the flag here have to agree, and the thresholds
  // were tuned over 329 swings on the understanding that there is one of them.
  const suspect = isSuspect(clip);
  const scored = clip.frames.filter((f) => f.poseScore !== undefined);

  return (
    <Section title="Measured">
      {m === undefined ? (
        <>
          <Row label="pose" value={NOT_MEASURED} absent />
          <Note>
            The ETL wrote no measurements for this swing — pose never locked onto a body,
            so there is nothing to judge the swing's speed or shape against.
          </Note>
        </>
      ) : (
        <>
          <Row
            label="wrist peak"
            title="Peak wrist speed, in torso heights per second. Saturates at 40."
            value={`${m.wristSpeed.toFixed(1)} th/s`}
          />
          <Row
            label="arm offset"
            title="Hitting wrist's distance from the body midline at contact, in torso heights"
            value={`${m.armOffset.toFixed(2)} th`}
          />
          <Row
            label="contact height"
            title="Contact's height within the crop, 0 at the top edge"
            absent={m.contactHeight === undefined}
            value={m.contactHeight === undefined ? NOT_MEASURED : m.contactHeight.toFixed(2)}
          />
          <Row
            label="torso height"
            title="The scale the numbers above are measured in, as a fraction of the crop"
            absent={m.torsoHeight === undefined}
            value={m.torsoHeight === undefined ? NOT_MEASURED : m.torsoHeight.toFixed(3)}
          />
          <Row
            label="hitting side"
            absent={m.hittingSide === undefined}
            value={m.hittingSide ?? NOT_MEASURED}
          />
          <Row
            label="pose frames"
            title="Pose is decoded over a narrower window than the stills are extracted over, so most frames carry no score"
            value={`${scored.length} of ${clip.frames.length} scored`}
          />
          {suspect && (
            <>
              <Row
                label="flag"
                value={
                  <Tag size="sm" hue="yellow" emphasis="strong" hint-size="auto,18px">
                    suspect
                  </Tag>
                }
              />
              <Note>
                Wrist slower than {SUSPECT_SPEED} torso-heights/s <em>and</em> still within{' '}
                {SUSPECT_ARM} of the body midline — the signature of a body standing still
                rather than a swing. A sorting aid, not a verdict: a genuine drop shot
                measures the same way.
              </Note>
            </>
          )}
        </>
      )}
    </Section>
  );
}

/** `161,842` — a box's top-left, in source-display pixels. */
const at = (b: ObjectBox): string => `${Math.round(b.x)},${Math.round(b.y)}`;

/** `122×105` — its size, in the same pixels. */
const size = (b: ObjectBox): string => `${Math.round(b.w)}×${Math.round(b.h)}`;

/**
 * What the COCO object detector saw on the contact frame.
 *
 * A separate group from `Measured` on purpose, and the reason is the space:
 * everything under `Measured` is crop-normalized against a rectangle
 * `--crop-mode` picks, while these are raw source-display pixels found before
 * any crop exists. Interleaving them would invite a reader to compare a 0.10
 * with an 842.
 *
 * Three states, not two, and the panel keeps them apart because they license
 * different conclusions: no block at all (nobody looked), a null member
 * (looked, found nothing) and a box. Only the middle one is about this swing,
 * and even then only weakly — see the notes.
 */
function Objects({ clip }: { clip: Clip }) {
  const o = clip.objects;

  if (o === undefined) {
    return (
      <Section title="Objects">
        <Row label="detector" value="not run" absent />
        <Note>
          No object detector ran over this swing — it was rendered before the COCO
          detector existed, or with <code>--objects-backend=none</code>. Nothing was
          looked for, so nothing here is missing.
        </Note>
      </Section>
    );
  }

  const racket = o.racket;
  const ball = o.ball;
  const motion = ball?.motion;
  // Judged, not just reported: a box detector cannot tell a ball in flight from
  // one of the several lying on the court, and there is usually one of those in
  // shot. `BALL_IN_FLIGHT` is the measured gap between the two populations.
  const flying = motion === undefined ? null : motion >= BALL_IN_FLIGHT;

  return (
    <Section title="Objects">
      <Row
        label="detector"
        absent={o.detector === undefined}
        value={o.detector ?? 'unknown'}
        title="Boxes below are in source-display pixels, NOT the crop-normalized space the measurements use"
      />

      <Row
        label="racket"
        absent={racket === null}
        value={
          racket === null ? (
            'not found'
          ) : (
            <Tag size="sm" hue="green" emphasis="soft" hint-size="auto,18px">
              found
            </Tag>
          )
        }
      />
      {racket !== null && (
        <>
          <Row
            label="racket conf"
            absent={racket.conf === undefined}
            value={racket.conf === undefined ? NOT_MEASURED : racket.conf.toFixed(2)}
            title="Detector confidence, 0-1"
          />
          <Row label="racket box" value={at(racket)} title={`${size(racket)} px, top-left at`} />
        </>
      )}

      <Row
        label="ball"
        absent={ball === null}
        title={
          flying === false
            ? 'Barely moving against the background: a ball on the court, not the one that was hit'
            : undefined
        }
        value={
          ball === null ? (
            'not found'
          ) : flying === false ? (
            <Tag size="sm" hue="yellow" emphasis="soft" hint-size="auto,18px">
              on the court
            </Tag>
          ) : (
            <Tag size="sm" hue="green" emphasis="soft" hint-size="auto,18px">
              {flying === true ? 'in flight' : 'found'}
            </Tag>
          )
        }
      />
      {ball !== null && (
        <>
          <Row
            label="ball conf"
            absent={ball.conf === undefined}
            value={ball.conf === undefined ? NOT_MEASURED : ball.conf.toFixed(2)}
          />
          <Row
            label="motion"
            absent={motion === undefined}
            value={motion === undefined ? NOT_MEASURED : motion.toFixed(0)}
            title="Deviation from a short background plate, 0-255. Under 20 the ball is lying still."
          />
          <Row
            label="to racket"
            absent={ball.racketDistance === undefined}
            value={
              ball.racketDistance === undefined
                ? 'no racket'
                : `${ball.racketDistance.toFixed(2)} th`
            }
            title={
              ball.racketDistance === undefined
                ? 'No racket was found, so there is nothing to measure the gap against'
                : 'Gap to the racket box, in torso heights. Near 0 on a well-timed contact frame.'
            }
          />
          <Row label="ball box" value={at(ball)} title={`${size(ball)} px, top-left at`} />
        </>
      )}

      {/*
        Said out loud, because "not found" on both rows otherwise reads as a
        verdict on the swing. It is not: the detector's own hit rates are low
        enough that a miss is the ordinary outcome.
      */}
      {racket === null && ball === null && (
        <Note>
          Nothing was found, which is common rather than damning: the racket turns up
          on 62% of swings and a ball in flight on 59%. The ball rate is only weakly
          discriminating — 32% of control moments five seconds or more from any shot
          also show one — so an empty block is not evidence this was not a swing.
        </Note>
      )}
      {flying === false && (
        <Note>
          A motion of {motion?.toFixed(0)} is a ball at rest: dead balls on the court
          measure 2-3 against 21-65 for confirmed in-flight ones. This box is one of
          the balls lying around, not the one that was hit.
        </Note>
      )}
    </Section>
  );
}

function Source({ clip, source }: { clip: Clip; source: EtlSource | null | undefined }) {
  const size = clip.clipSize;
  // `undefined` (the caller did not pass one) and `null` (the session had no
  // readable swing to probe) are one state to a reader: nothing is known about
  // the file behind this clip.
  const probe = source ?? null;

  return (
    <Section title="Source">
      <Row
        label="source video"
        absent={probe === null}
        value={probe?.name ?? 'unknown'}
        title={probe?.path}
      />
      <Row
        label="resolution"
        absent={probe === null}
        value={probe === null ? 'unknown' : `${probe.width}×${probe.height}`}
        title={
          probe === null
            ? undefined
            : `As stored. Rotation ${probe.rotation}° is applied on display.`
        }
      />
      <Row
        label="frame rate"
        absent={probe === null}
        value={
          probe === null ? 'unknown' : `${probe.fps.toFixed(2)} fps${probe.vfr ? ' (vfr)' : ''}`
        }
        title={probe?.vfr === true ? 'Variable frame rate: this is the average' : undefined}
      />
      <Row
        label="clip size"
        absent={size === undefined}
        value={size === undefined ? 'unknown' : `${size.width}×${size.height}`}
        title="Pixel size of the rendered clip, which can be smaller than the source"
      />
      <Row label="window" value={sourceRange(clip)} title="Where this clip was cut from" />
      <Row
        label="frames"
        value={`${clip.frames.length} stills`}
        title="Every still the ETL extracted for this swing"
      />
    </Section>
  );
}


/**
 * What the DETECTOR was told to do, and what it threw away.
 *
 * Session-scoped rather than per-swing, and the only place either is visible:
 * `rendered` counts what survived, so a session that discarded 40 candidates
 * looks identical to one that found 108 cleanly unless the histogram says so.
 * Tuning a detector against its own output (see the project's notes on this)
 * needs both numbers side by side.
 *
 * The settings keys are printed as they come rather than mapped to friendly
 * names: `tennisproc/config.py` owns them and adds to them freely, and a
 * hand-maintained label table would quietly go stale. `settings_hash` is
 * dropped because it identifies a tuning rather than describing one.
 */
function Session({
  settings,
  detection,
}: {
  settings: Record<string, unknown> | null;
  detection: Record<string, unknown> | null;
}) {
  if (settings === null && detection === null) return null;

  const counts = detection ?? {};
  const histogram = counts.reject_histogram;
  const rejects =
    typeof histogram === 'object' && histogram !== null
      ? Object.entries(histogram as Record<string, unknown>)
      : [];

  const tuning = Object.entries(settings ?? {}).filter(
    ([k, v]) => k !== 'settings_hash' && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'),
  );

  return (
    <Section title="Session">
      {['candidates', 'verified', 'rendered', 'rejected'].map((k) =>
        typeof counts[k] === 'number' ? (
          <Row key={k} label={k} value={String(counts[k])} />
        ) : null,
      )}
      {rejects.map(([reason, n]) => (
        <Row key={reason} label={`rejected: ${reason}`} value={String(n)} />
      ))}
      {tuning.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--gray-500)' }}>
            detector settings ({tuning.length})
          </summary>
          {tuning.map(([k, v]) => (
            <Row key={k} label={k} value={String(v)} />
          ))}
        </details>
      )}
    </Section>
  );
}

export function SwingMetadata({
  clip,
  source,
  settings = null,
  detection = null,
}: {
  /** The detector's tuning for this session, from the session document. */
  settings?: Record<string, unknown> | null;
  /** Candidate/verified/rejected counts and the reject histogram. */
  detection?: Record<string, unknown> | null;
  /** The selected swing, or `undefined` when nothing is selected. */
  clip: Clip | undefined;
  /**
   * What the probe read off the source video, from the session payload.
   *
   * Optional, and `null` is a real state rather than a mistake: a session with
   * no readable swing has no probe block to take it from. The panel says
   * "unknown" for those rows instead of hiding them, because a reviewer
   * comparing two sessions needs to see that the fact is missing here.
   */
  source?: EtlSource | null;
}) {
  if (clip === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.45,
            color: 'var(--gray-500)',
            padding: '16px 0',
            textWrap: 'pretty',
          }}
        >
          Select a swing to see what the probe and the detector recorded about it.
        </div>
        {/* Session facts describe the session, not the selection, so there is
            no reason to withhold them until one is made. */}
        <Session settings={settings} detection={detection} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Detector clip={clip} />
      <Measured clip={clip} />
      <Objects clip={clip} />
      <Source clip={clip} source={source} />
      <Session settings={settings} detection={detection} />
    </div>
  );
}
