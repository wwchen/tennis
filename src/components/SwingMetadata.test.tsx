import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import type { EtlSource, EtlSwingDoc } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
import { SwingMetadata } from './SwingMetadata';

/**
 * Everything below is built from the real ETL fixture rather than a hand-made
 * `Clip`, because the panel's whole job is to report what is on disk: a literal
 * would let a field drift out of the adapter and still pass here.
 */
const doc = realSwing as unknown as EtlSwingDoc;
const clipFrom = (mutate: (d: EtlSwingDoc) => void = () => {}) => {
  const copy = JSON.parse(JSON.stringify(doc)) as EtlSwingDoc;
  mutate(copy);
  return adaptSwing(copy);
};

const source: EtlSource = {
  name: 'IMG_0304.MOV',
  path: 'raw/IMG_0304.MOV',
  sha256_16: 'acb9171ceb5aaf7b',
  bytes: 82438795,
  duration_ms: 71633,
  fps: 29.999302,
  vfr: false,
  width: 1080,
  height: 1920,
  rotation: 90,
  has_audio: true,
};

describe('a fully measured swing', () => {
  it('reports every group, so no part of the pipeline is silently missing', () => {
    render(<SwingMetadata clip={clipFrom()} source={source} />);

    // The detector's own account.
    expect(screen.getByText('Detector')).toBeInTheDocument();
    expect(screen.getByText('audio_onset+pose_verify')).toBeInTheDocument();
    expect(screen.getByText('11.65')).toBeInTheDocument();

    // What it measured.
    expect(screen.getByText('Measured')).toBeInTheDocument();
    expect(screen.getByText('32.8 th/s')).toBeInTheDocument();
    expect(screen.getByText('0.10 th')).toBeInTheDocument();

    // What the file itself is.
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('1080×1920')).toBeInTheDocument();
    expect(screen.getByText('30.00 fps')).toBeInTheDocument();
  });

  it('no longer reports hand labels, which nothing populated in practice', () => {
    // The panel reports what the PIPELINE knows. Every value the removed group
    // showed already has an editable control elsewhere, and in a real tree they
    // were all null — so the group was seven rows of "unlabelled" on every swing.
    const clip = clipFrom((d) => {
      d.labels = { ...d.labels, player_name: 'Wen', quality: 4, verdict: 'valid' };
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.queryByText('Labelled by hand')).not.toBeInTheDocument();
    expect(screen.queryByText('unlabelled')).not.toBeInTheDocument();
    expect(screen.queryByText('Wen')).not.toBeInTheDocument();
    expect(screen.queryByText('4 of 5')).not.toBeInTheDocument();
  });

  it('places contact inside its own window, which is what says the cut was timed well', () => {
    // The fixture cuts 4801-8301ms around a contact at 6301ms: dead centre of a
    // 3.5s window. A contact drifting towards either edge is the failure this
    // row exists to make visible.
    render(<SwingMetadata clip={clipFrom()} source={source} />);
    expect(screen.getByText('0:06.301')).toBeInTheDocument();
    expect(screen.getByText('+1.5s')).toBeInTheDocument();
  });

  it('counts the frames pose actually scored, since most carry no score by design', () => {
    // Pose is decoded over a narrower window than the stills are extracted
    // over, so "28 of 49" is the healthy state — a bare count of 49 would claim
    // 21 silent failures that never happened.
    render(<SwingMetadata clip={clipFrom()} source={source} />);
    expect(screen.getByText('28 of 49 scored')).toBeInTheDocument();
  });
});

describe('a swing the ETL could not measure', () => {
  it('says so rather than reporting zero, which would read as a stationary player', () => {
    const clip = clipFrom((d) => {
      d.measurements = null;
      // The schema ties the two together: non-null measurements assert pose ran,
      // so a null block means no frame carries a score either.
      d.frames = d.frames.map((f) => ({ ...f, pose_score: null }));
    });
    expect(clip.measurements).toBeUndefined();

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('not measured')).toBeInTheDocument();
    // A zero wrist speed is a real, meaningful reading — a player who did not
    // move. It must never stand in for "we did not look".
    expect(screen.queryByText(/th\/s/)).not.toBeInTheDocument();
    expect(screen.queryByText('0.0 th/s')).not.toBeInTheDocument();
  });

  it('reports a half-measured block field by field, not all-or-nothing', () => {
    // Every field under `measurements` is optional in schema.py, so a swing can
    // carry the two speed numbers and no contact height. Losing the whole group
    // over one absent field would hide two values that were measured.
    const clip = clipFrom((d) => {
      const m = d.measurements as Record<string, unknown>;
      delete m.contact_height;
      delete m.torso_height;
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('32.8 th/s')).toBeInTheDocument();
    expect(screen.getAllByText('not measured')).toHaveLength(2);
  });
});

describe('the suspect flag', () => {
  it('flags a swing that measures as a body standing still', () => {
    // Slow wrist AND the wrist still at the midline — the pair `isSuspect`
    // tests. Neither alone flags anything, which the next case checks.
    const clip = clipFrom((d) => {
      const m = d.measurements as Record<string, unknown>;
      m.wrist_peak_speed = 2.27;
      m.contact_offset = 0.01;
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('suspect')).toBeInTheDocument();
    // The flag is useless without its rule: a reviewer has to know it is a
    // sorting aid before deciding whether to disagree with it.
    expect(screen.getByText(/torso-heights\/s/)).toBeInTheDocument();
  });

  it('leaves a fast swing unflagged, so the flag keeps meaning something', () => {
    render(<SwingMetadata clip={clipFrom()} source={source} />);
    expect(screen.queryByText('suspect')).not.toBeInTheDocument();
  });
});

describe('the objects the COCO detector found', () => {
  /** A found racket and an in-flight ball, shaped as `objects.py` writes them. */
  const withObjects = (over: Record<string, unknown> = {}) =>
    clipFrom((d) => {
      d.objects = {
        space: 'source_display',
        detector: 'yolo/coco',
        racket: { x: 161, y: 842, w: 122, h: 105, conf: 0.92 },
        ball: { x: 843, y: 982, w: 21, h: 26, conf: 0.44, motion: 56, racket_distance: 0.71 },
        ...over,
      };
    });

  it('reports both boxes, in their own space rather than the measured one', () => {
    render(<SwingMetadata clip={withObjects()} source={source} />);

    expect(screen.getByText('Objects')).toBeInTheDocument();
    expect(screen.getByText('yolo/coco')).toBeInTheDocument();
    expect(screen.getByText('found')).toBeInTheDocument();
    expect(screen.getByText('in flight')).toBeInTheDocument();
    // Source-display pixels, NOT the crop-normalized fractions `Measured` uses.
    // Reading one as the other is the mistake this group is separated to avoid.
    expect(screen.getByText('161,842')).toBeInTheDocument();
    expect(screen.getByText('843,982')).toBeInTheDocument();
    expect(screen.getByText('0.71 th')).toBeInTheDocument();
  });

  it('tells a ball on the court from one in flight, which a box alone cannot', () => {
    // Dead balls measure 2-3 against 21-65 in flight, so a detection at 3 is a
    // ball lying in shot — reporting it as "found" would credit the detector
    // with seeing the shot.
    const clip = withObjects({
      ball: { x: 843, y: 982, w: 21, h: 26, conf: 0.44, motion: 3 },
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('on the court')).toBeInTheDocument();
    expect(screen.queryByText('in flight')).not.toBeInTheDocument();
    expect(screen.getByText(/measure 2-3 against 21-65/)).toBeInTheDocument();
  });

  it('says a racket was found even when the ball was not, since they are independent', () => {
    const clip = withObjects({ ball: null });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('found')).toBeInTheDocument();
    expect(screen.getByText('not found')).toBeInTheDocument();
    // The gap needs both boxes, so no ball row may appear at all — a `to racket`
    // row here would report a distance to a ball that was never located.
    expect(screen.queryByText('0.71 th')).not.toBeInTheDocument();
    expect(screen.queryByText('motion')).not.toBeInTheDocument();
  });

  it('reads two nulls as a detector that found nothing, not as a verdict on the swing', () => {
    const clip = withObjects({ racket: null, ball: null });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getAllByText('not found')).toHaveLength(2);
    expect(screen.getByText(/62% of swings/)).toBeInTheDocument();
  });

  it('distinguishes a detector that found nothing from one that never ran', () => {
    // The whole point of the absent case. Every swing rendered before
    // `--objects-backend` existed omits the block, and "not found" there would
    // report a search that never happened.
    render(<SwingMetadata clip={clipFrom()} source={source} />);

    expect(screen.getByText('not run')).toBeInTheDocument();
    expect(screen.queryByText('not found')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing was looked for/)).toBeInTheDocument();
  });

  it('keeps a half-written box rather than losing the class it belongs to', () => {
    // `conf`, `motion` and `racket_distance` are present-only in schema.py, so
    // a box can carry geometry and none of them.
    const clip = withObjects({
      racket: { x: 161, y: 842, w: 122, h: 105 },
      ball: null,
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('161,842')).toBeInTheDocument();
    expect(screen.getByText('not measured')).toBeInTheDocument();
  });
});

describe('the session settings list', () => {
  it('picks up the new backends without an allowlist to keep in step', () => {
    // The list is built from whatever scalars the session document carries, so
    // `config.py` can add a key without this panel being edited. That is the
    // property under test: a hand-maintained label table would go stale.
    render(
      <SwingMetadata
        clip={clipFrom()}
        source={source}
        settings={{
          pose_backend: 'rtmpose',
          objects_backend: 'yolo',
          objects_weights: 'yolo11x.pt',
          settings_hash: 'deadbeef',
        }}
      />,
    );

    expect(screen.getByText('rtmpose')).toBeInTheDocument();
    expect(screen.getByText('yolo')).toBeInTheDocument();
    expect(screen.getByText('yolo11x.pt')).toBeInTheDocument();
    // A tuning's identity, not a description of one.
    expect(screen.queryByText('deadbeef')).not.toBeInTheDocument();
    expect(screen.getByText('detector settings (3)')).toBeInTheDocument();
  });
});

describe('a rejected swing', () => {
  it('names the check that failed instead of only saying it was rejected', () => {
    const clip = clipFrom((d) => {
      d.detection = { ...d.detection, verified: false, reject_reason: 'wrist_too_slow' };
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('wrist_too_slow')).toBeInTheDocument();
    // `rejected` folds the detector's call together with a human verdict; this
    // row has to keep saying which of the two rejected it.
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  it('explains a missing onset peak as a detector that never used audio', () => {
    const clip = clipFrom((d) => {
      d.detection = { ...d.detection, onset_peak: null };
    });

    render(<SwingMetadata clip={clip} source={source} />);
    expect(screen.getByText(/found from pose, not from an audio spike/)).toBeInTheDocument();
  });
});

describe('a session with no probe block', () => {
  it('says the source facts are unknown rather than hiding the rows', () => {
    // `source` is null for a tree with no readable swing to take it from. A
    // reviewer comparing two sessions has to see that the fact is missing here,
    // not find a shorter panel.
    render(<SwingMetadata clip={clipFrom()} source={null} />);

    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
    // The clip's own rendered size is on the clip, so it survives a null probe.
    expect(screen.getByText('386×480')).toBeInTheDocument();
  });
});

describe('with nothing selected', () => {
  it('invites a selection rather than rendering empty groups', () => {
    render(<SwingMetadata clip={undefined} source={source} />);

    expect(screen.getByText(/Select a swing/)).toBeInTheDocument();
    expect(screen.queryByText('Detector')).not.toBeInTheDocument();
  });
});
