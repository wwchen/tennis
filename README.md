# Shot Lab

Two halves of one workflow: a Python ETL that cuts a session video into
per-shot clips, and a React app for reviewing them frame by frame.

| | | |
| --- | --- | --- |
| **[`tennisproc/`](tennisproc/README.md)** | Python ETL | long video → per-swing clips, frames + metadata |
| **[`src/`](src/)** | React app | frame-level review: align, retag, rate, comment |
| **[`scripts/`](scripts/README.md)** | the loop | process every video reproducibly, then score what came out |

The ETL writes a `metadata.json` per swing with `stroke` and per-frame `stage`
left `null`; the app is where a human fills them in. The two are wired: in
`npm run dev`, [`vite-plugin-shot-lab.ts`](vite-plugin-shot-lab.ts) serves the
`out/` tree at `/api/session`, `/api/media` and `/api/swings`, the app reads
whichever session it is pointed at, and a reviewer's edits are written back as
`user-edit.json` beside the ETL's `metadata.json` — the one file the app is
allowed to write, into the one directory shape it is allowed to write it. The
twelve seeded fixture clips remain the fallback for a build with no tree
behind it: no dev server, no `out/`, a static deploy. The middleware is dev
only by design, so `vite build` never depends on it.

---

## The review app

A frame-level review tool for tennis clips. A clip is aligned on one of three
swing phases — **setup**, **contact**, **finish** — so that clips can be
compared column by column, and this app is where those tags come from. The ETL
supplies only contact, as the frame at `offset_contact_ms == 0`; setup and
finish are a human's call, as is correcting a bad contact, rating a shot,
retagging a stroke and pinning comments to individual frames.

Ported from the [Claude Design project][design] (`Shot Lab.dc.html`). The design
project remains the source of truth for the visual language; this repository is
the running implementation.

[design]: https://claude.ai/design/p/5fd67ca4-0dd8-4d16-9224-92eed95971e1

### Quick start

```bash
npm ci && npm run dev
```

Then open http://localhost:5173.

`make help` lists everything else. `make check` runs exactly what CI's `app`
job runs, in its order; the Python ETL has its own job and its own command
(`.venv/bin/python -m unittest discover -s tests`).

### What's in the box

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | `tsc --noEmit` then `vite build` into `dist/` |
| `npm run lint` | ESLint (typescript-eslint type-checked rules + react-hooks) |
| `npm run typecheck` | `tsc --noEmit` on its own |
| `npm test` | Vitest unit suite |

### Layout

```
src/
  domain/      types, seed fixture, grade + stroke lookups — no React
  state/       reducer, actions, localStorage persistence
  lib/         selectors: filtering, the alignment algorithm, stats
  components/  the four views, the filter rail, the frame inspector
  hooks/       outside-click / Escape dismissal for the inline editors
  lds.ts       the single import surface for the design system
```

The split that matters is `domain` + `state` + `lib` knowing nothing about
React. The alignment maths and every state transition are plain functions, which
is why the test suite drives them directly rather than through the DOM.

#### The alignment algorithm

`buildCompare` in [`src/lib/selectors.ts`](src/lib/selectors.ts) is the heart of
the compare view. Each clip's chosen anchor frame (setup / contact / finish) is
padded forward so that all of them land in the same column; columns are then
labelled by their offset from that anchor (`-2`, `-1`, `CONTACT`, `+1`, …). A
clip carrying no tag for the current anchor falls back to its midpoint frame.

#### Data

There is no server, only the dev middleware. In `npm run dev` the app lists
the sessions in `out/`, loads one, and writes a reviewer's verdicts back to
that swing's `user-edit.json`; a swing whose `metadata.json` the app cannot
read is skipped and reported rather than taking the whole session down with
it. Without a tree — a static build, or a checkout that has never run the ETL
— twelve clips are seeded from a fixture instead. Either way every edit
(ratings, comments, stroke/player corrections, removals) also persists to
`localStorage` under `shot-lab.doc`, versioned so an incompatible stored
document is discarded rather than half-migrated. Clearing site data resets to
the seed.

#### Design system

UI comes from `@lew-ds/lds-react`, with tokens, the core stylesheet and the
three self-hosted font families from `@lew-ds/lds`, and the icon sprite from
`@lew-ds/open-icons`. All three are pinned exactly and excluded from Dependabot:
they are the contract with the design project, and a minor bump can move
component markup out from under the layout. Nothing is loaded from a CDN — the
built image is entirely self-contained, which is what lets the CSP be as tight
as it is.

### Running the container

```bash
make up      # builds, serves the production bundle on 127.0.0.1:8080
make down
```

The image is a two-stage build: Node builds the bundle, Caddy serves it. A type
error fails the image, not just CI. Caddy handles the SPA fallback, sets the
CSP and security headers, caches fingerprinted `/assets/*` forever and
`index.html` never, and answers `/healthz` for the container healthcheck.

`out/` is mounted read-only at `/data`, and Caddy serves the two ETL routes
from it — `/api/media/*` as files, and `/api/session` from payloads
`scripts/session-index.ts` writes under `out/_index` ahead of time, since a
file server cannot walk a directory the way the dev middleware does. The
generator calls `readSession` itself, so the static route cannot drift from
the dev route it stands in for.

**Rerun `make session-index` after every `tennisproc` run.** `make up` depends
on it, but a session processed afterwards will not appear until the index is
rebuilt, and a stale index is indistinguishable from a session you have not
reviewed yet.

Read-only is deliberate: `user-edit.json` lives in that tree and is the one
thing the pipeline cannot regenerate from the source video. The consequence is
that **verdicts cannot be saved from the deployed app** — the `PUT` that stores
them 404s there. Review work happens against `npm run dev`; the container is
for looking, from anywhere.

#### Cloudflare Access

Authentication is enforced **at the Cloudflare edge**, the same way the roadtrip
stack does it. The container serves an unauthenticated static app; nothing
reaches it except through the tunnel.

That means two things about this repo:

- `web` publishes its port on `127.0.0.1` only. Binding it to `0.0.0.0` would
  put an unauthenticated copy of the app on the host's LAN address, right next
  to the copy Access is protecting. Cloudflare reaches the container over the
  Docker network at `http://web:80`.
- The Access policy itself lives in the Cloudflare Zero Trust dashboard, not in
  version control. This repo holds only the tunnel credential, as a Docker
  secret.

To stand it up:

1. In **Zero Trust → Networks → Tunnels**, create a tunnel and copy its token.
2. Write the token to `secrets/cloudflare_tunnel_token` on the deploy host
   (mode `600`; the path is gitignored). It is mounted as a Docker secret and
   passed as `TUNNEL_TOKEN_FILE` rather than `--token`, so it never appears in
   the container's command line where `ps` and `docker inspect` would show it.
3. Add a **public hostname** on that tunnel pointing at `http://web:80`.
4. In **Zero Trust → Access → Applications**, add a self-hosted application for
   that hostname and attach an allow policy (e.g. an email or group rule).
   Without this step the tunnel publishes the app to the whole internet — the
   tunnel provides connectivity, the Access application provides the gate.
5. Start it: `docker compose --profile tunnel up -d`.

Verify by loading the hostname in a private window: you should get Cloudflare's
sign-in screen before any of the app renders.

### CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) follows the roadtrip
conventions — every action pinned to a commit SHA, `concurrency` cancelling
superseded runs, and a final `ci-passed` job that aggregates the others so one
required check can gate the branch.

- **app** — install, lint, typecheck, test, build, upload `dist/`.
- **etl** — `tennisproc`, on its own job because it shares nothing with the
  app: install ffmpeg, then run the Python suite. It also asserts that no more
  than 12 tests skipped, because without ffmpeg the suite skips every
  end-to-end case and would otherwise report green while covering nothing.
- **docker-build** — build the image with GHA layer caching, smoke-test the
  running container (`/healthz`, that `/` is really the React shell, that
  unknown paths fall back to it), then tag and push to
  `ghcr.io/<owner>/<repo>/web:<sha>` on pushes and same-repo PRs.
- **ci-passed** — fails if anything above failed or was cancelled.

Images are addressed by commit SHA, never `latest`, so a deploy names exactly
one build.

### Security

[`.github/workflows/security.yml`](.github/workflows/security.yml) runs the two
GitHub Advanced Security surfaces that are expressible as workflows:

- **CodeQL** — `javascript-typescript`, `build-mode: none` (nothing to compile),
  `security-extended` query suite. On push, on PR, and weekly, because CodeQL
  ships new queries continuously and an unchanged tree can start failing without
  a commit.
- **Dependency review** — on PRs only, since the action diffs base against head
  manifests. Fails the check when a PR introduces a known-vulnerable package at
  high severity or above.

Neither is wired into `ci-passed`. A scan finding is not a reason to block an
image build, and coupling them means a CodeQL outage stops deploys. Add them as
required checks in branch protection instead, where they belong.

#### Settings, not files

The remaining surfaces are repository settings and cannot be committed. All of
these are already applied to `wwchen/tennis`; the commands are here for a fork
or a rebuild.

GitHub turns secret scanning and push protection on by default for a public
repo, so in practice only these need running:

```bash
gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts
gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting
gh api -X PATCH repos/{owner}/{repo} --input - <<'JSON'
{"security_and_analysis":{"dependabot_security_updates":{"status":"enabled"}}}
JSON
```

Note the request shape: `secret_scanning_push_protection` is a **sibling** of
`secret_scanning`, not nested inside it, and the nested `security_and_analysis`
object needs a JSON body — `gh api -F key[sub]=value` does not build one.

Push protection is the one that earns its keep: it rejects a commit carrying a
recognised credential at push time, the only point where the fix is still cheap.
Once a secret reaches the remote, rotating it is the only real remedy; scrubbing
history is theatre.

Two toggles are **not** available here and will silently stay `disabled` even
though the API returns 200 — they require a GHAS licence, which a free personal
repo does not carry:

- `secret_scanning_non_provider_patterns` (generic/unbranded secrets)
- `secret_scanning_validity_checks` (does this leaked key still work?)

On a **private** repo, CodeQL and secret scanning themselves also require GHAS.
On a public repo both are free. Dependabot and dependency review work either
way.

### Deploying

CI stops at a pushed image; putting one in front of the tunnel is manual, and
runs on the host holding `secrets/cloudflare_tunnel_token`. From a checkout of
the commit you mean to ship:

```sh
make session-index                       # or a session processed since the last
                                         # deploy will not appear
SHOT_LAB_SHA=$(git rev-parse HEAD) \
  docker compose --profile tunnel up -d --build
```

Then check the container, not just the site:

```sh
docker compose ps                        # image tag names the deployed commit
curl -s localhost:8080/api/session | head -c 60
```

`/api/session` is the check that matters. Every route answers 200 whether or not
the ETL mount is working, because Caddy's SPA fallback returns `index.html` for
anything it cannot serve — so a broken deploy looks healthy and quietly shows
seed data. JSON means the tree is mounted; `<!doctype html>` means it is not.

The SHA tag is what makes a deploy nameable, so keep the commit reachable from
a branch: **build after any `--amend` or rebase, never between.** Otherwise the
tag names a tree nobody can check out, and `docker compose ps` stops answering
what is live — an image ran for a day tagged with a commit no branch contained,
amended away ninety seconds after it was built.

Deploy from `main`. Everything the container needs is there, which is the point
of merging the ETL mount rather than carrying it on a branch: a tree missing it
loses `/api` in exactly the silent way described above.

The roadtrip pattern to mirror when this is automated is a `deploy.yml`
triggered by `workflow_run` on CI success, joining the tailnet, installing a
release over SSH and running `docker compose --profile tunnel up -d` on the
host.

---

## The ETL

[`tennisproc`](tennisproc/README.md) turns a long session video into the clips
this app reviews: swings found, clips cut, frames extracted, metadata written.
See its README for tuning, the output layout and the full schema; this is the
short version.

```bash
brew install ffmpeg            # or: sudo apt-get install -y ffmpeg
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# the normal way: everything in raw/ -> out/, then scored
scripts/process.sh
scripts/process.sh IMG_0305    # or one session

# the pieces, if you want them
.venv/bin/python -m tennisproc run      ~/Downloads/session.MOV --outdir out
.venv/bin/python -m tennisproc validate out/session

.venv/bin/python -m unittest discover -s tests
```

[`scripts/process.sh`](scripts/README.md) is the one to reach for: it caches,
it records what produced each tree in `out/manifest.jsonl` (commit, settings,
wall time, swing count), and it prints the score afterwards. `tennisproc
detect` renders nothing but keeps no cache, so with the vision detector it
re-scans the whole video every time it is asked.

`ffmpeg` and `ffprobe` are required, not optional — without them 87 of the
suite's 341 cases skip, every end-to-end test among them. CI installs ffmpeg
and then fails the job if more than 12 tests skipped.

Pose is a separate install and is not needed for the tests. When you do want
it: `pip install "mediapipe==0.10.35"` on **Python 3.13 specifically**, since
newer versions abort on macOS. `requirements.txt` carries the model download.

**Pose needs a logged-in GUI session.** Over ssh or from a background job,
MediaPipe does not raise — it aborts the process. `tennisproc` checks for a
window server first and says so. `--pose-backend=stub` runs everything except
real pose detection, which is how the Python suite works headless.

### How swings are found

**The body says *that* a swing happened; the sound says *when*.** `scan.py`
runs pose over the whole video at 10 fps and takes the peaks of wrist speed as
swings, then gives each peak the timestamp of the nearest audio onset within
0.8 s. A peak with no strike near it hit nothing and is dropped.

It used to be the other way round — audio proposed, pose disposed — and the
inversion is measured. A room rings, so one swing arrives at the onset
detector as three or four onsets: 268 onsets for IMG_0305's 75 real swings,
440 for IMG_0306's 117. Most of them are not on any swing in frame at all —
194 of IMG_0305's 268 — part echoes of a real strike off net, fence and wall,
part strikes nobody in frame made, from the next court. No threshold on a
waveform separates either kind from a shot, because they are the same sound.
Audio-first therefore emitted about 3.6 clips per real swing; vision-first
emits 0.97 on IMG_0305 and 1.26 on IMG_0306, at 89% and 91% recall.

Audio keeps the job it is best at, which is the one it was always best at: a
ball strike is a sharp broadband transient and locates contact to about ±20
ms, where a 10 fps scan can only say "somewhere in this tenth of a second". So
a silent video is still rejected outright, and the onset is what dates every
swing.

Motion differencing was tried and abandoned before either of these: on a fixed
camera the players move almost constantly, so it finds one long blob per rally
and cannot say where one shot ends and the next begins.

### What it writes

```
out/<video-stem>/
  metadata.json                  session: source, settings, swing index
  run.log                        the stage counts for the last run
  work/                          the cached pose scan and landmark tracks
  swings/swing_001/
    clip.mp4                     3.5s around contact, whole frame
    frames/frame_0000.jpg ...    7 stills, 0.5s apart, whole frame
    pose.json                    landmarks per frame
    metadata.json                written by the ETL
    user-edit.json               written by a reviewer, same schema
```

Whole frames, not crops: `crop_mode` defaults to `"full"` because the pose
crop is measured over a ±0.4 s window and then applied to a 3.5 s clip, which
produced clips whose first still was an empty court. Seven stills rather than
a dense native-fps run for the same reason of proportion — the wide sparse
span shows a whole swing at a twentieth of the bytes. Both are settings, and
[`tennisproc/README.md`](tennisproc/README.md) says what each costs.

One document shape written to two files: `metadata.json` is what the machine
knows, `user-edit.json` is the same document with human fields filled in. The
ETL only ever writes the first, so it can be re-run without destroying review
work. Reading a swing means overlaying them, joining frames on `source_ms`
rather than array index — so re-extracting at a different frame rate leaves a
human's contact label on the same *moment*. Validated examples of all three
document types are in [`docs/examples/`](docs/examples/).

`stroke` and per-frame `stage` ship `null`. Classification is deliberately not
part of the ETL; it can land later as a separate step writing the same fields.

### What is and isn't verified

**Quote recall against clustered ground truth, always.**
`tests/fixtures/known_shots.json` holds 354 shot times, and it is tempting to
say "recall against 354 known shots". Those are audio *onsets* from the
previous pipeline, not swings: one swing appears two or three times, and
IMG_0304 lists 12 of them for the 6 swings the video actually contains.
Clustered at 1.0 s the fixture is **198 swings**, which is the denominator
that means anything. Scoring unclustered pays a detector for finding echoes,
and it is exactly how this project talked itself into an audio-first design
that emitted 3.8 clips per swing.

[`scripts/evaluate.py`](scripts/README.md) does the clustering. Over the
current `out/` tree it reports 67% / 89% / 91% recall on IMG_0304 / 0305 /
0306, at 1.50 / 0.97 / 1.26 clips per real swing — and IMG_0304 is six swings
in 72 seconds, far too small to resolve either figure.

[`tests/test_real_footage.py`](tests/test_real_footage.py) is *not* that
measurement, whatever its name suggests. It runs the audio onset detector
alone against all 354 unclustered entries, and what it usefully guards is that
`onset_k` still hears what it used to hear. Precision remains weakly measured:
only 4 of 1,647 rendered swings so far carry a human "not a swing" verdict.
Everything after the scan — player zones, cropping, the reject histogram — is
exercised in tests only on synthetic fixtures, because MediaPipe cannot run
headless.

The Python suite is stdlib `unittest`, not pytest, and is not part of
`npm test`. CI runs it in its own `etl` job.
