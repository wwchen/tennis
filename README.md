# Shot Lab

Two halves of one workflow: a Python ETL that cuts a session video into
per-shot clips, and a React app for reviewing them frame by frame.

| | | |
| --- | --- | --- |
| **[`tennisproc/`](tennisproc/README.md)** | Python ETL | long video → per-shot clips, cropped per player, frames + metadata |
| **[`src/`](src/)** | React app | frame-level review: align, retag, rate, comment |

The ETL writes a `metadata.json` per swing with `stroke` and per-frame `stage`
left `null`; the app is where a human fills them in. **The two are not wired
together yet** — the app currently seeds twelve clips from a fixture and the ETL
writes to `out/`. Connecting them means teaching the app to read the ETL's
schema, which [`docs/examples/`](docs/examples/) documents.

---

## The review app

A frame-level review tool for tennis clips. Each clip's **setup**, **contact**
and **finish** frames are tagged; this app is where a coach checks that work —
aligning every clip on the same swing phase so they can be compared column by
column, correcting bad tags, rating shots, and pinning comments to individual
frames.

Ported from the [Claude Design project][design] (`Shot Lab.dc.html`). The design
project remains the source of truth for the visual language; this repository is
the running implementation.

[design]: https://claude.ai/design/p/5fd67ca4-0dd8-4d16-9224-92eed95971e1

### Quick start

```bash
npm ci && npm run dev
```

Then open http://localhost:5173.

`make help` lists everything else. `make check` runs exactly what CI runs, in
CI's order.

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

There is no backend. Twelve clips are seeded from a fixture and every edit —
ratings, comments, stroke/player corrections, removals — persists to
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

Deployment is not wired up yet: CI stops at a pushed image. The roadtrip pattern
to mirror when that changes is a `deploy.yml` triggered by `workflow_run` on CI
success, joining the tailnet, installing a release over SSH and running
`docker compose --profile tunnel up -d` on the host.

---

## The ETL

[`tennisproc`](tennisproc/README.md) turns a long session video into the clips
this app reviews: shots found, clips cut, cropped per player, frames extracted,
metadata written. See its README for tuning, the output layout and the full
schema; this is the short version.

```bash
brew install ffmpeg            # or: sudo apt-get install -y ffmpeg
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/python -m tennisproc detect ~/Downloads/session.MOV   # tune, renders nothing
.venv/bin/python -m tennisproc run    ~/Downloads/session.MOV --outdir out
.venv/bin/python -m tennisproc validate out/session

.venv/bin/python -m unittest discover -s tests
```

`ffmpeg` and `ffprobe` are required, not optional — without them the suite
still prints `OK` while skipping every end-to-end test.

Pose is a separate install and is not needed for the tests. When you do want
it: `pip install "mediapipe==0.10.35"` on **Python 3.13 specifically**, since
newer versions abort on macOS. `requirements.txt` carries the model download.

**Pose needs a logged-in GUI session.** Over ssh or from a background job,
MediaPipe does not raise — it aborts the process. `tennisproc` checks for a
window server first and says so. `--pose-backend=stub` runs everything except
real pose detection, which is how the Python suite works headless.

### How shots are found

A ball strike is a sharp broadband transient, which locates contact to about
±20 ms; at 30 fps a frame is 33 ms and the ball moves feet between frames, so no
visual estimate comes close. Pose then confirms a body actually swung at that
moment, rejecting bounces, claps and the feeder. The crop is the union of the
tracked player's pose boxes, so it follows the *player* rather than whatever
moved.

Motion differencing was tried and abandoned: on a fixed camera the players move
almost constantly, so it finds one long blob per rally and cannot say where one
shot ends and the next begins.

### What it writes

```
out/<video-stem>/
  metadata.json                  session: source, settings, swing index
  swings/swing_001/
    clip.mp4                     a few seconds around contact, cropped
    frames/frame_0000.jpg ...    native fps, cropped
    pose.json                    landmarks per frame
    metadata.json                written by the ETL
    user-edit.json               written by a reviewer, same schema
```

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

Detection recall is **99–100%** against 354 known shot times from three real
sessions ([`tests/test_real_footage.py`](tests/test_real_footage.py), which
skips unless the videos are present). Everything after the audio stage — pose
verification, player zones, cropping — is exercised only on synthetic fixtures,
because pose cannot run in CI or any headless environment. Precision is
unmeasured: on one session the audio stage yields 267 candidates against 151
known shots, and it takes pose or a human to say what the rest are.

The Python suite is stdlib `unittest`, not pytest, and is not part of `npm test`
or the CI workflow. Nothing in CI runs it yet.
