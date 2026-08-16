# tennisproc

Turn a long video of a tennis session into a reviewable dataset: shots found,
clips cut, cropped per player, frames extracted, metadata written.

**Classification is not part of this package.** Stroke type and per-frame swing
stage ship as `null` fields for a human to fill in via a review website. A
classifier can land later as a separate step writing the same fields, without
touching the ETL or migrating the schema.

## Quick start

```bash
# what is this video?
.venv313/bin/python -m tennisproc probe ~/Downloads/IMG_0305.MOV

# how many shots would it find, without rendering anything?
.venv313/bin/python -m tennisproc detect ~/Downloads/IMG_0305.MOV

# the whole ETL
.venv313/bin/python -m tennisproc run ~/Downloads/IMG_0305.MOV --outdir out

# check the output against the schema
.venv313/bin/python -m tennisproc validate out/IMG_0305
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
detect    audio onsets -> shot candidates
pose      one decode pass per candidate -> landmark track     (cached)
verify    accept or reject each candidate; measure the swing
render    cut the clip, extract the frames
index     write the session document
```

Each is a separate subcommand and the expensive stage caches, so re-rendering
or re-tuning the detector never re-runs pose.

**Why audio finds the shots.** A ball strike is a sharp broadband transient, so
it locates contact to about ±20 ms. At 30 fps a frame is 33 ms and the ball
moves feet between frames, so no visual estimate comes close. Pose then
confirms a body actually swung at that moment, which is what rejects bounces,
claps and talking. A video with no audio track fails loudly rather than
quietly producing worse output.

**Why pose does the cropping.** The crop is the union of the tracked player's
pose boxes across the swing, padded. Pose is already computed for
verification, and unlike frame differencing it follows the *player* rather than
whatever moved, so it does not chase the ball, the other player, or a car
behind the court.

## Tuning

`detect` renders nothing, so sweeping the threshold is cheap:

```bash
for k in 4 6 8 12; do
  .venv313/bin/python -m tennisproc detect ~/Downloads/IMG_0305.MOV --onset-k $k
done
```

It prints the candidate count, the verified count, and a histogram of why
candidates were rejected:

```
detect: 290 candidates at k=8.0
verify: 191 accepted, 99 rejected
  no_pose          41
  wrist_too_slow   33
  torso_too_small  14
  onset_off_swing   8
```

Read the histogram before reaching for a knob. `no_pose` dominating means the
player is too small in frame -- try `--pose-tiles 3`. `wrist_too_slow`
dominating means the detector is firing on ball bounces -- raise `--onset-k`.
Shots missing entirely means the opposite: lower it.

| Flag | Default | What it does |
|---|---|---|
| `--onset-k` | 8.0 | Audio threshold, in MADs above the median. Lower finds more and admits more noise. |
| `--gap` | 0.12 | Collapse candidates closer together than this many seconds. |
| `--min-wrist-speed` | 0.45 | Reject swings slower than this, in torso heights per second. |
| `--pose-tiles` | 0 | Vertical tiles for small players; 0 probes automatically. |
| `--span` | 1.6 | Total seconds of frame stills around contact. |
| `--fps` | 0 | Stills per second; 0 uses the source rate. |
| `--long-edge` | 640 | Longest side of a frame still, in pixels. |
| `--pre` / `--post` | 1.5 / 2.0 | Clip bounds either side of contact. |
| `--players` | 0 | Force a player count; 0 detects it. |

`--gap` deserves a note, because every intuitive value for it is wrong. It
looks like it should merge the several noises *one* swing makes — the strike,
then the ball hitting a fence — but the onset detector's own refractory period
already does that, so this is near-inert by design.

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
  work/                          caches, keyed by source + settings hash
    pose.jsonl.gz
  swings/
    swing_001/
      clip.mp4                   a few seconds around contact, cropped
      frames/frame_0000.jpg ...  native fps, cropped, ~49 stills
      pose.json                  landmarks per frame
      metadata.json              written by the ETL
      user-edit.json             written by the website, same schema
```

Frames are extracted at the source frame rate by default. A human relabelling
the true contact frame cannot do it on a sparse grid, so density is the point,
and it is the main size driver: measured on a deliberately high-detail
1080x1920 source, about 92 KB per still and **5.9 MB per swing**, so roughly
1.8 GB for a 300-swing session. Low-detail footage is far smaller. Reduce
`--span`, `--fps`, `--long-edge` or `--quality` if that is too much.

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

- **Audio is required.** No pose-only fallback; a silent video is rejected.
- **No identity tracking.** Players are positional zones, not people.
- **One crop rectangle per clip.** `crop.static` is always `true`; a player who
  runs a long way ends up with a loose crop.
- **Only the audio stage is measured on real video.** Detection recall is
  99–100% against 354 known shot times in three real sessions
  (`tests/test_real_footage.py`). Everything after it — pose verification,
  player zones, cropping — is exercised only on synthetic fixtures, because
  pose cannot run in this environment. In particular the reject histogram's
  balance and the crop's framing are unproven on real footage.
- **Precision is unmeasured.** Recall says known shots are found; nothing here
  says how many of the extra candidates are spurious. On IMG_0305 the audio
  stage yields 267 candidates against 151 known shots, and it takes pose (or a
  human) to say what the remainder are.

## Tests

```bash
.venv313/bin/python -m unittest discover -s tests -v
```

Stdlib `unittest`, because there is no network in this environment to install
pytest. The `StubBackend` is what makes the suite possible at all: it injects
synthetic landmark tracks, so the whole ETL runs headless where MediaPipe would
abort. It also reproduces the free-arm-is-wider geometry deliberately, so the
hitting-wrist selection is tested against the real failure mode rather than a
friendly case.
