# tennisproc

Turn a long video of a tennis session into a reviewable dataset: swings found
by watching the body and dated by the sound of the strike, clips cut, frames
extracted, metadata written.

**Classification is not part of this package.** Stroke type and per-frame swing
stage ship as `null` fields for a human to fill in via a review website. A
classifier can land later as a separate step writing the same fields, without
touching the ETL or migrating the schema.

## Install

Python 3.9 or newer, plus `ffmpeg` and `ffprobe` on PATH. Those two are not
pip-installable and nothing here works without them: every stage shells out to
ffmpeg, and 87 of the test suite's 341 cases skip when they are missing.

```bash
brew install ffmpeg            # or: sudo apt-get install -y ffmpeg

python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # at the repo root
```

Pose is optional and separate. `--pose-backend=stub` runs the whole pipeline
without it, which is the only way this package works on a headless machine at
all. Real detection needs a desktop session, MediaPipe, and the model:

```bash
.venv/bin/pip install mediapipe
curl --create-dirs -o models/pose_landmarker_lite.task \
  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
```

## Quick start

```bash
# what is this video?
.venv/bin/python -m tennisproc probe ~/Downloads/IMG_0305.MOV

# how many shots would it find, without rendering anything?
# (not cheap: with the vision detector this pose-scans the whole video,
#  and unlike `run` it keeps no cache -- see Tuning)
.venv/bin/python -m tennisproc detect ~/Downloads/IMG_0305.MOV

# the whole ETL
.venv/bin/python -m tennisproc run ~/Downloads/IMG_0305.MOV --outdir out

# check the output against the schema
.venv/bin/python -m tennisproc validate out/IMG_0305
```

### Pose needs a logged-in GUI session

MediaPipe on macOS needs a window server. Without one -- over ssh, from a
launchd job, in a background process -- it does not raise an error, it
**aborts the process** inside `DrishtiMetalHelper`. Neither `delegate=CPU` nor
`MEDIAPIPE_DISABLE_GPU=1` avoids it.

`tennisproc` checks `CGMainDisplayID()` before the first detection and fails
with an explanation instead of dying halfway through a session. Run it from a
terminal in a normal desktop login, or use `--pose-backend=stub` to exercise
everything except real pose detection.

## The stages

```
probe     ffprobe: dimensions, rotation, frame rate, audio
scan      pose over the whole video at 10fps -> wrist-speed peaks    (cached)
detect    each peak takes the timestamp of its nearest audio onset
pose      one dense landmark track per surviving candidate           (cached)
verify    accept or reject each candidate; measure the swing
render    cut the clip, extract the frames
index     write the session document
```

`scan` runs inside `detect`; the subcommands are `probe`, `detect`, `run`,
`validate` and `show`. Both pose passes cache under `out/<stem>/work/`, keyed
by a hash of only the settings that change which frames get decoded
(`config._CACHE_KEYS`), so re-rendering never re-runs pose. Re-tuning the
*detector* does re-run it, which is new: the scan is what decides which
windows exist at all.

**Why the body finds the shots and the sound dates them.** A ball strike is
one sound to a person and several to a detector. The room rings, the ball
reaches the fence, the next court is playing too — so every audio threshold
emits a cluster per swing. Measured at the shipped `--onset-k 8.0`, from the
`detect` lines in `out/<stem>/run.log`:

| session | audio onsets | real swings | onsets per swing | onsets on nobody's swing |
|---|---|---|---|---|
| IMG_0304 | 44 | 6 | 7.3 | 35 |
| IMG_0305 | 268 | 75 | 3.6 | 194 |
| IMG_0306 | 440 | 117 | 3.8 | 292 |

The last column — `len(onsets) - len(candidates)`, as the `detect` line
reports it — is the part no threshold can fix. Some of those are the ringing:
one strike arriving three more times off net, fence and wall. The rest are
real strikes nobody in frame made, from the next court or a ball worked back
off the fence. Both are the same sound as a shot, and nothing in the waveform
says whether anybody in frame swung.

A body has no such problem — it swings once, and it is in frame or it is not.
So `scan.py` samples pose across the whole video at 10fps and takes the peaks
of wrist speed as swings, which answers the question audio cannot ask at all.

**Audio keeps the job it is genuinely best at.** A strike is a sharp broadband
transient and locates contact to about ±20 ms, where a 10fps scan can only say
"somewhere in this tenth of a second". So each vision peak adopts the
timestamp of the nearest onset within `audio_window_s` (0.8 s), and that
timestamp is what every clip is centred on and every `offset_contact_ms` is
measured from. A peak with no sound near it hit nothing — a practice cut, a
whiff, a player walking the motion through — and is dropped: 40 of 188 peaks
on IMG_0306. A video with no audio track is still rejected outright rather
than quietly producing worse output.

What the change bought, from `scripts/evaluate.py` over the current `out/`
tree (recall against `known_shots.json` **clustered to one entry per swing**,
see [Known limitations](#known-limitations)):

```
session       swings     real   recall  per swing
IMG_0304           9        6      67%      1.50x
IMG_0305          73       75      89%      0.97x
IMG_0306         147      117      91%      1.26x
```

against 3.8–3.9 candidates per real swing for the audio-first detector at
comparable recall, which is the same ratio as the onset table above because
the audio detector's candidates *were* the onsets. IMG_0304 is 72 seconds and six swings: it cannot resolve
either column, and the one time this project trusted it over the larger
sessions it cost a third of the shots everywhere else. The measurements behind
the design are in the header of [`scan.py`](scan.py).

**Why pose does the cropping, when there is a crop.** `--crop pose` sets the
rectangle to the union of the tracked player's pose boxes across the swing,
padded. Pose is already computed for verification, and unlike frame
differencing it follows the *player* rather than whatever moved, so it does
not chase the ball, the other player, or a car behind the court.

The default is nonetheless `--crop full`, the whole frame. The pose box is
measured over `pose_window_s` — ±0.4 s — and then applied to everything the
renderer writes: a 3.5 s clip, and stills reaching ±1.5 s at the settings
`scripts/process.sh` ships. IMG_0304/swing_015 came out as a 404×764 strip the
player entered around −0.5 s and had left by +1.5 s, so its first still was an
empty court. Padding cannot fix that; the problem is the fraction of the clip
the box was measured over, not its size. Use `--crop pose` when the frame span
is inside the pose window, where a tight frame on the body is exactly what a
reviewer wants.

## Tuning

Use [`scripts/process.sh`](../scripts/README.md), not a bare `detect` loop.
`detect` renders nothing, but it passes no work directory, so with the vision
detector it re-scans the entire video on every invocation and caches nothing.
`process.sh` writes into `out/<stem>/work/`, so the second run of a render
knob is seconds.

`detect` is still the way to see one video's stage counts without writing
clips:

```bash
.venv/bin/python -m tennisproc detect ~/Downloads/IMG_0307.MOV
```

It prints the scan, the corroboration, and a histogram of why candidates were
rejected — this is IMG_0307's, from its `run.log`:

```
scan: 7280 pose samples, 374 swing peaks
detect: 270 candidates (104 peaks had no strike within 0.8s; 586 audio onsets not on a swing)
pose: 270 tracks
verify: 222 accepted, 48 rejected
  torso_too_small  23
  reanchor_too_slow 18
  no_pose          7
```

Read the histogram before reaching for a knob.

- `torso_too_small` or `no_pose` dominating means the player is too small in
  frame. That is what `pose_tiles: 3` and `pose_min_confidence: 0.2` are for
  and they are already the defaults; the sweep behind them is in
  [`config.py`](config.py).
- `reanchor_too_slow` dominating means strikes are landing where nobody was
  swinging — an adjacent court, a ball off the fence. It is a screen, not a
  correction: nothing is re-anchored (see [Known
  limitations](#known-limitations)).
- Peaks with no strike, high in the `detect` line, means the players are
  swinging without connecting, or the sound is too far from the motion —
  `audio_window_s`.
- Shots missing entirely means the scan never saw them: lower `scan_k`.

| Flag | Default | What it does |
|---|---|---|
| `--onset-k` | 8.0 | Audio threshold, in MADs above the median. Lower finds more onsets and admits more noise. |
| `--gap` | 0.12 | Collapse verified swings closer together than this many seconds. |
| `--min-wrist-speed` | 0.45 | Reject swings slower than this, in torso heights per second. |
| `--reanchor-min-speed` | 12.0 | The speed a swing must show when its wrist peak is far from the strike. Misnamed: it screens, it never moves anything. |
| `--pose-tiles` | 3 | Vertical tiles for a player too small to detect whole. 0 or 1 means no tiling; there is no auto-probe. **Not 2** — see `config.py`. |
| `--crop` | full | `full` renders the whole frame; `pose` crops to the tracked player. |
| `--span` | 1.6 | Total seconds of frame stills around contact. |
| `--fps` | 0 | Stills per second; 0 uses the source rate. |
| `--long-edge` | 640 | Longest side of a frame still, in pixels. |
| `--pre` / `--post` | 1.5 / 2.0 | Clip bounds either side of contact. |
| `--players` | 0 | Force a player count; 0 detects it. |

The scan's own knobs — `detector`, `scan_fps`, `scan_k`, `scan_min_gap_s`,
`audio_window_s` — and `pose_min_confidence` have **no command-line flags**.
Change them in [`config.py`](config.py), where each default carries the
measurement that chose it, and where a new number is expected to arrive with
its own.

`--gap` deserves a note, because every intuitive value for it is wrong. It
looks like it should merge the several noises *one* swing makes — the strike,
then the ball hitting a fence — but `audio.REFRACTORY_S` already suppresses a
strike's own echo inside the onset detector, and the vision detector thins its
peaks at `scan_min_gap_s` (1.0 s) and again after snapping them to onsets. So
this is near-inert by design. It now runs in `dedupe_swings`, *after*
verification and on the anchored contact, so a real shot is never discarded in
favour of a nearby noise pose would have thrown out.

Measured over 351 pose-verified shots in three real sessions, the closest
genuine pair of shots is **0.12 s** apart and the 10th percentile is 0.14 s:
players hit much faster than feels believable. What a threshold costs:

| `--gap` | real shots discarded |
|---|---|
| 0.12 s | 0% |
| 0.15 s | 15% |
| 0.35 s | 38% |
| 3.5 s | 60%+ |

The 3.5 s an earlier version of this project inherited turned 191 detected
shots into 87. Raise this only if a specific video double-reports, and check
the cost first.

## Output

```
out/IMG_0305/
  metadata.json                  session: source, settings, swing index
  run.log                        the stage counts for the last run
  work/                          caches, keyed by source + settings hash
    scan.jsonl.gz                the whole-video pose scan
    pose.jsonl.gz                the per-candidate landmark tracks
  swings/
    swing_001/
      clip.mp4                   3.5s around contact (--pre 1.5 --post 2.0)
      frames/frame_0000.jpg ...  stills around contact
      pose.json                  landmarks per frame
      metadata.json              written by the ETL
      user-edit.json             written by the website, same schema
```

How many stills, and how big, is entirely a settings question, and the answer
changed. `tennisproc run` on its own still extracts at the source frame rate
over `--span 1.6` — 49 stills 33 ms apart. [`scripts/process.sh`](../scripts/README.md)
ships `--fps 2 --span 3.0 --crop full` instead, which is **7 stills 0.5 s
apart** spanning ±1.5 s, and that is what is on disk: measured over IMG_0305,
about 27 KB per still and **300 KB per swing**, so 22 MB for its 73 swings.

The trade is deliberate and it costs something real. Dense native-fps stills
were how a human was meant to *correct* contact: at 30 fps the ball moves feet
between frames, so seeing which frame the strike is really on takes neighbours
33 ms either side. At `--fps 2` that job is gone. Contact itself is still on
the grid — `frame_times_ms` builds outward from it, so IMG_0305/swing_001's
stills sit at −1500, −1000, −500, **0**, +500, +1000, +1500 ms — but the
nearest thing to compare it against is half a second away, and no reviewer can
move a contact label onto a frame that was never extracted.

What the sparse wide span buys instead is a swing readable end to end, setup
through follow-through, at a twentieth of the bytes, which is what made
processing fifteen sessions at once possible at all. Frame-exact contact
labelling wants `--fps 0 --span 1.6` — and at that span `--crop pose` becomes
reasonable again too, since the stills then fall inside the window the crop was
measured over.

Filenames carry no meaning: `metadata.json` owns every timestamp. Frame
indices are four digits so they still sort correctly at `--fps 60`.

## Schema

One document shape, `SwingDoc`, written to two files:

| File | Written by | Contents |
|---|---|---|
| `metadata.json` | the ETL | everything the machine knows; label fields `null` |
| `user-edit.json` | the website | the same document, human fields filled in |

The website reads `metadata.json`, edits, and writes the whole document back to
`user-edit.json`. One validator serves both. Reading a swing means overlaying
them, which `tennisproc show` and `session.load_swing()` both do.

Two files rather than editing in place, so the ETL can be re-run at any time
without destroying human work: it only ever writes `metadata.json`.

Complete validated examples are in [`../docs/examples/`](../docs/examples/).

### What goes where

| Block | Question it answers | Written by |
|---|---|---|
| `source` | which video, what shape | ETL |
| `trim` | where the clip was cut from | ETL |
| `crop` | which rectangle of the frame | ETL |
| `detection` | where the detector fired, and whether it passed | ETL |
| `labels` | player, stroke, quality, verdict, tags | ETL fills `player_slot`; human fills the rest |
| `frames[]` | per-frame time, pose score, and stage | ETL, except `stage` |
| `measurements` | measured numbers, not opinions | ETL |
| `edit` | who reviewed it and against what | human |

`frames[].stage` answers *when* (which frame is contact); the fields in
`labels` answer *what* (is this a forehand). Both are human-editable.

### Three rules the schema keeps

**One fact in one place.** `detection.contact_ms` is where the detector fired
and is never rewritten. If a human decides contact was a frame later, that
goes in `user-edit.json` as a `stage` label. Because the ETL owns
`contact_ms`, every frame's `offset_contact_ms` stays meaningful instead of
going stale the moment someone edits.

**Stable keys, never array indices.** Frame identity is `source_ms`,
milliseconds into the source. An index like `frames[8]` silently means a
different moment after `--fps` changes, and `user-edit.json` is written by a
different process at a different time. `overlay()` joins on `source_ms`, so
re-extracting at 60 fps leaves a human's contact label on the same *moment*.

**A swing directory stands alone.** `source` is copied into every swing rather
than referenced, and `measurements` and `pose.json` sit beside the frames. Ship
`swing_042/` to a labeller or into a training set and it still says where it
came from, and carries the numbers a training run needs without re-processing
the video. The earlier generation of this project stored neither, so its 46
hand labels were only usable while the exact source file stayed in place under
the exact path recorded in one central file.

### Enumerations

Defined in `schema.py` and nowhere else.

```python
STAGES   = setup, contact, finish, other
STROKES  = forehand, backhand, volley, serve, overhead, other
VERDICTS = valid, false_positive, duplicate, unclear
QUALITY  = 1..5
```

`STROKES` is coarse deliberately. Ganser et al. (*Sensors* 21(17):5703, 2021)
managed only F1 72-80% separating slice from topspin with a 1660 Hz wrist IMU;
at 30 fps it is not recoverable, so spin is not in the vocabulary. `overhead`
is separate from `serve` because an overhead off a fed ball is neither.

### `player_slot` is not a person

`player_slot` is a court zone -- `left`/`right`, or `near`/`far` -- assigned by
clustering swing positions. It is all a pipeline can honestly know, and it
stops meaning the same person the moment two players change ends. That is why
`player_name` is a separate field only a human fills.

## Known limitations

- **Audio is required.** No pose-only fallback; a silent video is rejected,
  and a vision peak with no strike near it is dropped. The sound is what dates
  every swing.
- **No identity tracking.** Players are positional zones, not people. Both
  measurement paths now refuse to measure *across* a change of person —
  `scan.wrist_speed_series` and `verify.wrist_speeds` skip any triple whose
  body midline moves more than `pose.BODY_JUMP` — but neither one knows who
  it is following. See below.
- **Speeds are only as good as the body tracking.** `Track.series` indexes
  poses positionally, and the detector's per-frame ordering is not stable, so
  before this guard a "wrist" could teleport between players. Over 396 shipped
  swings, 49% of measured series contained such a jump and 43% reported a peak
  that sat on one. Because `verify` picks the slot with the fastest wrist, a
  flip also chose *which player* got measured: guarding changes the recorded
  `hitting_side` on 26% of swings. Recall is unchanged (67/89/91%) and clips
  per real swing improve slightly (1.50/0.97/1.26 → 1.33/0.96/1.24).
  **Trees rendered before this fix carry the old values.**
- **`wrist_peak_speed` still saturates.** `verify.SPEED_CAP` is 40 torso
  heights per second, which is roughly the physical ceiling for a hand. The
  guard above took saturation from 73% of swings to 39%, so the number
  discriminates over most of its range now, but the top of the distribution is
  still pose jitter rather than swing speed, and `dedupe_swings` breaks ties on
  it.
- **Nothing is re-anchored to the wrist peak.** Moving contact from the audio
  onset to the fastest wrist sample was tried and reverted. Against the 12
  verified shot times in IMG_0304, recall was 100% measured on the onset and
  **58%** measured on the moved value, which sat 0.2–0.35 s away; the onset was
  exact for 10 of the 12. Audio locates a strike to about ±20 ms and an argmax
  over a 24-frame track cannot beat that. `reanchor_min_speed` and the
  `reanchor_too_slow` reject reason keep the name and have stopped doing the
  thing: the peak's distance from the strike is now evidence that nobody was
  swinging, not a correction to apply. `verify.ONSET_OFF_SWING` is likewise
  dead as a code path — nothing returns it — but stays in
  `schema.REJECT_REASONS` because output trees already on disk record it.
- **Clips and stills are whole frames.** `crop_mode` defaults to `"full"`. The
  pose crop is real and works, but it is measured over ±0.4 s and applied to a
  3.5 s clip; see [Why pose does the cropping](#the-stages) above. With
  `--crop pose`, one rectangle per clip: `crop.static` is always `true`, so a
  player who runs a long way gets a loose crop.
- **The stills are too sparse to correct contact on.** 7 per swing at 0.5 s
  spacing, at the settings `scripts/process.sh` ships. The contact still is
  there; its neighbours are half a second away, so a reviewer can confirm the
  detector's instant but cannot move it. That needs `--fps 0`.
- **The recall number is not the one it looks like.** See below.

### The recall trap

`tests/fixtures/known_shots.json` holds **354 shot times** over three
sessions, and this project spent a day being misled by that number. The file
lists audio *onsets* from the previous generation of the pipeline, not swings:
one swing appears two or three times in it. IMG_0304 has 12 entries for 6 real
swings, verified by watching the video. Clustered at 1.0 s, the fixture is 6 +
75 + 117 = **198 swings**.

So any recall figure has to say which count it is against:

- `scripts/evaluate.py` clusters, and is the number to quote. Over the current
  `out/` tree that is 67% / 89% / 91% on IMG_0304 / 0305 / 0306, at 1.50 /
  0.97 / 1.26 clips per real swing.
- `tests/test_real_footage.py` does **not** cluster, and does not measure the
  shipped detector at all: it runs `audio.detect` alone against all 354
  entries, at a 0.15 s tolerance. What it asserts is that the onset detector
  still hears what it used to hear — a real regression test for `onset_k`, and
  the one that caught `min_gap_s` being wrong twice. It is not swing recall,
  and the 99–100% it reports must never be quoted as such. Scoring a detector
  against that file unclustered rewards it for finding echoes.

Precision is still weakly measured. Vision-first cut the extra clips from 3.8
per swing to near 1, but "near 1" is an average over a clustered fixture, not
a count of false positives; only 4 of 1,647 rendered swings carry a human
`false_positive` verdict so far. Everything after the scan — player zones,
cropping, the reject histogram's balance — is exercised in tests only on
synthetic fixtures, because MediaPipe cannot run headless.

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v
```

341 tests, about a minute. **Check the skip count.** Without ffmpeg on PATH,
87 of them skip -- every end-to-end test among them -- so a green run means
very little on its own; CI fails the job if more than 12 skip. On a machine
with ffmpeg and with the session videos in `raw/`, expect exactly one skip,
the display check.

Stdlib `unittest`, because there is no network in the environment this was
built in to install pytest. The `StubBackend` is what makes the suite possible
at all: it injects synthetic landmark tracks, so the whole ETL runs headless
where MediaPipe would abort. It reproduces the free-arm-is-wider geometry
deliberately, so hitting-wrist selection is tested against the real failure
mode rather than a friendly case, and its wrist *accelerates* through the
middle of each track, so peak speed lands at contact the way a real swing
does.

`TestDefaultSettingsEndToEnd` runs the pipeline with `config.Settings()`
untouched apart from the backend. Every other end-to-end test narrows the
frame span to keep its fixture small, and three defects once lived in exactly
that blind spot -- including one that made every default run abort after
writing a clip and 49 stills. Do not fix a failure there by narrowing the
span.
