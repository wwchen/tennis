# Processing and tuning

One command produces every clip, and one command scores it. The loop is meant
to be run repeatedly as more footage arrives — each pass tells you what the
last settings change cost.

## Process

```bash
scripts/process.sh                 # everything in raw/
scripts/process.sh IMG_0304        # one session
JOBS=1 scripts/process.sh          # serial, if the machine is busy
```

Writes `out/<stem>/` and appends a line to `out/manifest.jsonl` recording the
commit, the settings, the wall time and the swing count. That manifest is the
answer to "what produced this tree" — a question this project could not answer
for a day, having rendered six sessions with four versions of the detector.

The commit is suffixed `+dirty` when the working tree is not clean, which is
honest rather than decorative: a dirty commit id names a tree nobody can get
back, so a manifest line full of them is a warning that the comparison you are
about to make is between two things you cannot re-create.

Each session also keeps its own `out/<stem>/run.log` with the stage counts.

## Score

Runs automatically after `process.sh`, or on its own:

```bash
.venv/bin/python scripts/evaluate.py out
.venv/bin/python scripts/evaluate.py out IMG_0305
```

```
session       swings     real   recall  per swing  rejected
IMG_0304           9        6      67%      1.50x          -
IMG_0305          73       75      89%      0.97x          -
IMG_0306         147      117      91%      1.26x          -
```

Only these three sessions have ground truth; the rest print swing counts and
nothing else.

- **real** — swings in `tests/fixtures/known_shots.json`, **clustered at 1.0s**.
  The file lists audio *onsets* from an earlier pipeline, so one swing appears
  two or three times in it (12 entries for the 6 swings in IMG_0304). Scoring
  against it unclustered rewards a detector for finding echoes, which is
  exactly the mistake that sent this project backwards.
- **per swing** — clips emitted per real swing. 1.0 is one clip per swing. The
  audio-first detector sat near 3.8, because it was counting a room's echoes.
- **rejected** — swings you marked "not a swing" in the review app. Sparse, but
  the only reference that is certainly right.

## Tuning

Change one setting, re-run, read the two numbers that came back:

```bash
SETTINGS="--fps 2 --span 3.0 --crop full --min-wrist-speed 0.6" \
  scripts/process.sh IMG_0305 IMG_0306
```

`SETTINGS` is passed straight to `tennisproc run`, so only things with a
command-line flag can go in it. **The scan's own knobs have none** —
`detector`, `scan_fps`, `scan_k`, `scan_min_gap_s`, `audio_window_s` and
`pose_min_confidence` are edited in `tennisproc/config.py`, which is also where
every default carries the measurement that chose it.

The loop, in full:

1. Pick a knob and predict what it should do.
2. `scripts/process.sh <two sessions>` — the evaluation prints itself.
3. Compare **recall** and **per swing** against the previous run. Both matter:
   a knob that improves one by wrecking the other has not helped.
4. Keep it or revert it, and either way write down what you saw.

Two rules, both learned expensively:

**Tune on more than one session.** `onset_k` was raised to 15.0 on 15 human
verdicts from a single 72-second clip. On that clip it looked like a precision
win, 33% to 71%. Measured across three sessions it cost a quarter of IMG_0305's
shots and nobody noticed for a day, because the only test that measures recall
was silently skipping. `min_gap_s` was raised to 0.25 the same way, to suppress
duplicate clips, and cost recall on every session measured. IMG_0304 is the
trap: with six real swings it cannot resolve a 25-point drop, so it agrees with
whatever you just did.

**Write the measurement next to the number you change.** Every default in
`config.py` is followed by the sweep that chose it — `onset_k` by a
session-by-session recall table, `pose_tiles` by detection rates on four
sessions, including the note that 2 tiles measured *worse* than none. A
threshold with no measurement beside it is how every regression in this
pipeline happened, and it is also what stopped the next person re-raising
`onset_k`: the table says what it costs.

## What re-runs, and what does not

Both pose passes are cached under `out/<stem>/work/`, keyed by a hash of every
setting that changes which frames get decoded:

| change | cost |
|---|---|
| render knobs (`--fps`, `--span`, `--crop`, `--long-edge`, `--quality`, `--pre`, `--post`, `--pad`) | re-render only, seconds |
| verify knobs (`--min-wrist-speed`, `--min-torso`, `--gap`, `--reanchor-min-speed`) | re-render only |
| detector and pose knobs (`--onset-k`, `--pose-window`, `--pose-tiles`, `--pose-backend`, and every `scan_*` field in `config.py`) | full pose pass, minutes to hours |

The authoritative list is `config._CACHE_KEYS`, and both of its rules have
already bitten: a knob the pose pass consumes but that is missing from the list
silently reuses stale work (`pose_backend` once let a stub run's stick figures
feed a real run), and a knob it does not consume but that is listed throws an
expensive pass away for nothing (`min_gap_s` and `min_torso` used to).

So sweeping a verify or render threshold is cheap, and sweeping the detector is
not — which is new. Under the audio-first detector, `--onset-k` was free. The
scan now decides which windows pose decodes at all, so moving anything upstream
of it re-scans the video.

`tennisproc detect` is *not* the cheap way round this: it renders nothing, but
it passes no work directory, so it re-scans the whole video every time and
throws the scan away. Use it to look at one video's stage counts, not to
sweep.

## The stages

```
scan     pose across the whole video at 10fps -> wrist-speed peaks   (cached)
detect   each peak takes the timestamp of its nearest audio onset
pose     one dense landmark track per surviving candidate     (cached)
verify   accept or reject; measure the swing
render   cut the clip, extract the stills
index    write the session document
```

The body decides *that* a swing happened; the sound decides *when*. A strike on
the next court, a bounce beside a stationary player and a ball hitting the
fence are all loud, and none of them move a wrist in frame — which is why the
detector no longer starts from audio. See the header of `tennisproc/scan.py`
for the measurements.
