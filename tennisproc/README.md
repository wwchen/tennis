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

**RTMPose is the better backend and needs no display.** It runs through
ONNX with no `mmcv`/`mmpose` install, and models download themselves on first
use to `~/.cache/rtmlib` (~90 MB), so there is no model file to fetch by hand:

```bash
.venv/bin/pip install rtmlib onnxruntime
# then: --pose-backend=rtmpose
```

**Racket and ball detection is optional and off by default.** `tennis racket`
and `sports ball` are two of COCO's eighty classes, so stock weights need no
training and no labelling:

```bash
.venv/bin/pip install ultralytics
# then: --objects-backend=yolo
```

`ultralytics` is AGPL-3.0 and pulls torch (~2 GB). Fine privately; a licensing
decision if this is ever redistributed. That is why the stage is opted into
rather than out of, and why neither package is in `requirements.txt`.

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
objects   racket and ball at each contact, from COCO weights     (optional)
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

## Which pose backend

Three exist: `mediapipe`, `rtmpose` and `stub`. **Prefer `rtmpose`.**

MediaPipe puts the hitting wrist in the wrong place often enough to break the
measurements built on it. Scored against a COCO-pretrained racket box -- a
correctly located hitting wrist must sit on or beside the racket the hand is
holding -- over the 41 IMG_0684 swings where a hand-checked racket box sat on
the tracked player:

| landmark | within 0.25 torso | within 0.5 |
|---|---|---|
| MediaPipe wrist the pipeline chose | 54% | 63% |
| MediaPipe nearest of its two wrists | 63% | 73% |
| RTMPose nearest of its two wrists | **90%** | **95%** |

On 24% of those swings the MediaPipe hitting wrist sat more than a whole torso
height from the racket. That is the failure behind crops centred on an ankle,
and it also explains detections that look like a bad racket box and are
actually a bad wrist: of racket boxes more than 1.9 torso from the wrist, a
quarter were on the player and only the wrist was wrong.

**The swap also removes candidates that were never swings.** RTMPose finds
fewer: 77 accepted on IMG_0684 against MediaPipe's 108, which looks like lost
recall until the two sets are refereed by something neither backend can see.
A real strike should have a ball in flight at the racket; a split-step should
not. Scoring both sets over identical frames, so that the ball detector's
session-to-session unreliability cancels:

| candidate set | n | racket found | ball in flight | ball at the racket |
|---|---|---|---|---|
| MediaPipe | 108 | 73% | 57% | 31% |
| RTMPose | 77 | 62% | 81% | **43%** |

**The absolute number of strikes is the same in both: 33.** The 31 candidates
RTMPose drops contain none of them. Note the racket rate falls while the ball
rate rises, which is the signature expected of the surviving set being
mid-swing -- a racket in motion blurs and gets harder to detect, a stationary
one held in front of a player at rest does not.

This is one session, and "ball at the racket" is itself a partial test: it
fires on 43% of a set that is certainly more than 43% real swings, so read it
as a relative measure between two candidate sets, never as an absolute count
of strikes.

**Device matters more than model size.** Seconds per frame, and the resulting
whole-video scan pass (5016 frames at 10 fps over a 502 s session):

| mode | cpu | accelerated |
|---|---|---|
| performance | 0.373 (31.2 min) | 0.060 (5.0 min) |
| balanced | 0.287 (24.0 min) | 0.049 (4.1 min) |
| lightweight | 0.087 (7.3 min) | 0.026 (2.2 min) |

MediaPipe scans the same session in 1.9 min. Defaulting RTMPose to CPU made
the accurate backend 16x slower than the one it replaces; on the accelerator
it is 2.6x, which is affordable for the accuracy. The backend picks its own
device from onnxruntime's provider list.

`RTMPoseBackend` uses rtmlib's `Wholebody` even though this package reads only
the 17 body joints, because `Body` in `performance` mode bundles YOLOX-x
(351 MB) as its person detector while `Wholebody` uses RTMDet: measured 0.82
s/frame at 88% against 0.32 s/frame at 90%. The larger-sounding model is the
cheaper one.

**One trap.** CoreML cannot run the person detector's output node when that
output is *empty* -- a frame with nobody in it gives a dynamic-shaped tensor
with zero elements and the provider raises rather than returning nothing. The
scan pass walks the whole video and meets frames with the player out of shot
on every session, so this crashed a full run 40 s in. The exception is
translated into the empty result it stands for, matched narrowly on the error
text: catching everything there would turn a genuinely broken accelerator into
a session that silently finds no swings.

## Racket and ball

`--objects-backend=yolo` writes an `objects` block into each swing document:
racket and ball boxes in **source-display pixels**, not crop-normalized like
`measurements`. They are found on the full frame before any crop exists, and
converting at write time would bake in a rectangle `--crop-mode` can change.

Two things are this package's own; the detector is stock and untested here,
because testing it would be testing ultralytics.

**Which racket box belongs to the player.** A raw detection is not enough. Of
39 racket boxes sitting more than 1.9 torso heights from the hitting wrist, 0%
were on the second person in frame, 25.6% were on the player with a misplaced
wrist, and 74.4% were on nothing at all. A box is accepted when it is near the
wrist **or** overlaps the tracked player, never both: 53.7% recall for the
wrist test alone, 38.9% for the overlap test alone, **62.0% for either** --
because the wrist test survives a bad player box and the overlap test survives
a bad wrist.

**Whether a ball is in flight.** Detection alone is nearly worthless: the court
fills with dead balls as a session runs and the detector finds them all,
reporting a ball at **79.2%** of control moments when nothing was being
struck. Motion against a short background plate separates them -- a ball at
15 m/s covers most of a torso height between frames, one lying on the court is
in every plate frame and cancels:

| motion threshold | at contact | at control (>=5 s from any shot) | lift |
|---|---|---|---|
| 10 | 69.4% | 45.5% | +23.9 |
| **20** | **59.3%** | **31.7%** | **+27.6** |
| 40 | 34.3% | 13.9% | +20.4 |
| 50 | 16.7% | 3.0% | +13.7 |

20 was checked at its own boundary rather than in the comfortable middle: a
candidate scoring 21 was confirmed by eye to be a real ball. Dead balls score
2-3.

**That lift does not survive a change of session, and this is the weakest
claim on the page.** Re-run over 24 swings each of four other sessions, using
the shipped rules:

| session | shape | racket found | ball at contact | ball at control | lift |
|---|---|---|---|---|---|
| IMG_0684 | portrait | 62% | 59% | 32% | +27 |
| IMG_0685 | portrait | 62% | 46% | 14% | +32 |
| IMG_0689 | landscape | 75% | 58% | 71% | **-13** |
| IMG_0693 | landscape | 83% | 46% | 0% | +46 |
| IMG_0696 | landscape | 42% | 62% | 42% | +21 |
| **all, n=96** | | **66%** | **53%** | **32%** | **+22** |

The aggregate lift is close to the single-session figure, and the racket rate
holds up and is if anything better. But the per-session ball lift runs from
-13 to +46, and on IMG_0689 the control fires MORE often than contact does --
there, this test is worse than useless.

Swing density does not explain it: IMG_0693 has the tightest median gap
between swings (2.8 s) and the largest lift, while IMG_0689 sits mid-pack at
3.7 s and goes negative. The cause is not known. Until it is, read a ball
detection as suggestive on a session you have checked and as nothing at all on
one you have not.

Neither half works alone, which is why both are required. A plate-only test
cannot tell a ball from a shoe -- a heel is bright, convex, ball-sized at this
scale, and moving.

**Inference width is not a free knob.** Racket found within reach of the hand:
48.1% at `--imgsz 640`, 53.7% at 1280, 53.7% at 1920. At 640 a 1080x1920 frame
is squashed threefold and a motion-blurred racket stops looking like one; on
the first frame this was checked against, 640 found no racket at all. 1920
buys nothing over 1280 and costs twice the time.

The confidence floor is deliberately low at 0.10. Boxes at 0.12 and 0.22 were
both confirmed correct by eye, and raising the floor to 0.25 costs about ten
points of recall to remove detections that are right. Confidence barely
separates good boxes from bad here: median 0.74 near the hand against 0.67 on
the false ones.

`scripts/detect_objects.py` exports the same detections for a whole video as
gzipped JSONL, one line per sampled frame, for drawing over playback. Sampling
rate is the decision there: a racket interpolates smoothly at 10 fps, a ball
does not -- below native rate it teleports, and a straight line between two
samples passes through positions it never occupied.

**How far these numbers have actually been checked.** The racket rate and the
ball lift are measured across five sessions (96 swings, both orientations);
the racket rate holds, the ball lift does not. Everything else -- the
MediaPipe-versus-RTMPose comparison, the acceptance-rule recall figures, the
imgsz and confidence sweeps, and every precision figure -- comes from
`IMG_0684` alone, an indoor portrait net drill, backed by a few dozen hand
checks. The corpus is 25 sessions and most are landscape, several outdoor
doubles at distance. Treat the single-session numbers as an order of
magnitude, not a value.

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
| `--gap` | 2.0 | Collapse verified swings closer together than this many seconds, *and* in the same place on court. |
| `--same-place` | 2.0 | How close two contacts must be, in torso heights, to count as one player. |
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

`--gap` and `--same-place` work as a pair, and neither is safe alone.

The failure they fix, confirmed frame by frame: the racket strikes, then the
wrist peaks a *second* time on the follow-through more than a second later,
that peak finds a nearby sound, and the swing ships twice. `IMG_0684`
swing_006/007 are 1.30 s apart — the first has ball blur leaving the strings,
the second is the player standing with the racket at their chest.

An earlier default of 0.12 s could never fire: `scan.corroborate` already thins
candidates to `scan_min_gap_s` (1.0 s), and exactly **one** adjacent pair in the
whole 2505-swing corpus sits below that. The old note claiming 0.12 s was the
closest genuine pair measured *the gap between any two detections*, most of
which are two players rallying, not one player hitting twice.

Separating those two populations needs ground truth, which the ball-machine
sessions supply: a Rayleigh periodogram finds a feed lattice in 16 of 26
sessions (`IMG_0687`–`0691` at 3.45 s, `IMG_0694`–`0696` at 2.571 s), and **76
adjacent pairs land in a single feed slot** — two detections claiming one ball.

| population | n | gap |
|---|---|---|
| two detections of one ball | 76 | min 1.00 s, median 1.30 s, p90 1.53 s, max 2.01 s |
| same player hitting twice (A-B-A triples) | 171 | min **2.53 s**, p05 3.26 s, median 7.06 s |
| two players rallying | 336 | min **1.00 s**, p10 1.55 s |

The empty band from **1.53 s to 2.53 s** is where `--gap` 2.0 cuts. But the
third row is why the time test cannot stand alone: a bare 2.0 s threshold eats
real exchanges. Hence `--same-place`, measured over the 597 pairs under 2.5 s:

| | n | min apart | median |
|---|---|---|---|
| same `player_slot` | 513 | 0.00 torsos | 0.53 |
| different slots | 84 | **2.12 torsos** | 6.34 |

At 2.0 torsos the guard merges **0 of the 84** two-player pairs; without it, 39
real exchanges collapse. It also catches what `player_slot` cannot — `IMG_0693`
swing_009/010 are visibly two people 1.07 s apart in a session the clusterer
called single-player, 2.85 torsos apart, correctly kept.

Together these remove **250 of 2505 swings (10%)**, concentrated in the
weak-lattice sessions (`IMG_0473` 24%, `IMG_0477` 27%) — which are also the
sessions where the result is least verifiable, being distant outdoor doubles.

**Which member survives is chosen for coverage, not for correctness.** Nothing
the pipeline measures identifies the real strike: over the feed-slot collisions
`onset_peak`, `|contact_offset|`, `torso_height` and `wrist_peak_speed` all
score between 50% and 61%, which at that sample size is a coin flip.
`wrist_peak_speed` is the worst of them, because `verify.SPEED_CAP` clips at
40.0 and 1575 of 2505 swings (63%) sit exactly on the cap. So `dedupe_swings`
optimises for keeping the strike **on screen** instead: the window is
asymmetric (`--pre` 1.5 s, `--post` 2.0 s), so keeping the earlier member
covers the other contact for gaps up to 2.0 s while keeping the later covers
only 1.5 s. Above 1.5 s the earlier member therefore wins outright; below it,
where either window contains both contacts, the louder onset decides.

Applies to **future runs only**. Dedupe renumbers `swings/swing_NNN`, and
`user-edit.json` is keyed by that directory, so re-running an existing session
orphans every review onto a different shot. `min_gap_s` and `same_place_torsos`
are not in `_CACHE_KEYS`, so the scan and pose caches survive and a re-run
takes minutes — but the cost is human: re-review, or a one-off remapper keyed
on `detection.contact_ms`, which is stable across the re-run for every swing
dedupe keeps.

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
