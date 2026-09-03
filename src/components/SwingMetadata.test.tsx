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
  it('reports all four groups, so no part of the pipeline is silently missing', () => {
    render(<SwingMetadata clip={clipFrom()} source={source} />);

    // The detector's own account.
    expect(screen.getByText('Detector')).toBeInTheDocument();
    expect(screen.getByText('audio_onset+pose_verify')).toBeInTheDocument();
    expect(screen.getByText('11.65')).toBeInTheDocument();

    // What it measured.
    expect(screen.getByText('Measured')).toBeInTheDocument();
    expect(screen.getByText('32.8 th/s')).toBeInTheDocument();
    expect(screen.getByText('0.10 th')).toBeInTheDocument();

    // What a human said.
    expect(screen.getByText('Labelled by hand')).toBeInTheDocument();

    // What the file itself is.
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getByText('1080×1920')).toBeInTheDocument();
    expect(screen.getByText('30.00 fps')).toBeInTheDocument();
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

describe('what a human has not labelled', () => {
  it('reads an unset stroke as unlabelled, and says no model was ever going to fill it', () => {
    const clip = clipFrom();
    expect(clip.stroke).toBeNull();

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getAllByText('unlabelled').length).toBeGreaterThan(0);
    // The load-bearing half: an empty stroke row otherwise reads as a
    // prediction that failed, and the ETL has no stroke classifier at all.
    expect(screen.getByText(/does not predict strokes/)).toBeInTheDocument();
  });

  it('shows a court slot without passing it off as a player name', () => {
    // `clip.player` collapses these two, so "left" alone cannot be told apart
    // from somebody actually called left.
    render(<SwingMetadata clip={clipFrom()} source={source} />);
    expect(screen.getByText('left')).toBeInTheDocument();
    expect(screen.getAllByText('unlabelled').length).toBeGreaterThan(1);
  });

  it('echoes the values once a human has set them', () => {
    const clip = clipFrom((d) => {
      d.labels = {
        ...d.labels,
        player_name: 'Wen',
        stroke: 'backhand',
        quality: 4,
        verdict: 'valid',
        tags: ['late', 'open stance'],
        notes: 'contact behind the hip',
      };
    });

    render(<SwingMetadata clip={clip} source={source} />);

    expect(screen.getByText('Wen')).toBeInTheDocument();
    expect(screen.getByText('Backhand')).toBeInTheDocument();
    // 4 of 5, not "Good": the three rating chips lose two of quality's values.
    expect(screen.getByText('4 of 5')).toBeInTheDocument();
    expect(screen.getByText('valid')).toBeInTheDocument();
    expect(screen.getByText('late, open stance')).toBeInTheDocument();
    expect(screen.getByText('contact behind the hip')).toBeInTheDocument();
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
