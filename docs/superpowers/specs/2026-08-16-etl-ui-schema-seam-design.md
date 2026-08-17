# Wiring the ETL schema to the review UI

**Status:** implemented. Known gaps and their resolutions are tracked in
[`2026-08-16-etl-ui-schema-seam-followups.md`](2026-08-16-etl-ui-schema-seam-followups.md);
this document has been corrected where the follow-up work changed the design.
**Date:** 2026-08-16

## Problem

The two halves of Shot Lab do not talk to each other. `tennisproc` writes a
`SwingDoc` per swing to `out/`; the React app seeds twelve fixture clips from
`src/domain/seed.ts` and reads no files at all. Nothing in `src/` performs a
`fetch`.

The vocabularies also disagree in ways that are not renames. Making the UI run
on real ETL output means resolving those disagreements, choosing a transport,
and — because a reviewer's labels are the entire point of the app — closing the
loop back to `user-edit.json`.

Measured against one real session (`IMG_0304.MOV`, 42 swings):

| | ETL `SwingDoc` | App `Clip` |
|---|---|---|
| frames per swing | 42–49 | `FRAMES_PER_CLIP = 9`, fixed (now the compare-grid window; a `Clip` carries all 42–49) |
| frame identity | `source_ms` | `i`, an array index |
| strokes | `forehand backhand volley serve overhead other` | `Forehand Backhand Serve Volley Slice` |
| stages | `setup contact finish other` | `setup contact finish` |
| per-frame confidence | none (`pose_score` is detection quality) | `conf`, drives `CONFIDENCE_FLOOR` |
| labels present | all `null` by design | populated in the fixture |

## File ownership in `out/`

The output tree is shared state with split ownership, not a one-way pipe. Every
path below is verified against the code: all `tennisproc` writes go through
`session.write_json` or `render.py`, and `user-edit.json` appears in the ETL
only as a read (`session.py:141`, `schema.py:393`).

| Path | ETL | App |
|---|---|---|
| `metadata.json` (session) | writes | reads |
| `work/pose.jsonl.gz` | writes | ignores |
| `swings/swing_NNN/metadata.json` | writes | reads |
| `swings/swing_NNN/pose.json` | writes | reads (skeleton overlay, future) |
| `swings/swing_NNN/clip.mp4` | writes | reads |
| `swings/swing_NNN/frames/*.jpg` | writes | reads |
| `swings/swing_NNN/user-edit.json` | **reads** | **writes** |

Two consequences:

- **`reviewed` is derived, not stored.** `session.py:102` computes it from whether
  `user-edit.json` exists, so the app creating that file is what marks a swing
  reviewed. There is no separate flag to keep in sync.
- **"Safe to re-run" means labels survive, not that nothing changes.** A re-run
  rewrites `clip.mp4` and `frames/` (`render.py:118`, `:148`), so the pixels a
  human reviewed against can change even though their labels persist. `edit.against`
  carries the `doc_hash` of the metadata that was reviewed precisely so
  `overlay()` can report this rather than let it pass silently.

## Principle: the ETL schema is authoritative

Where the two disagree, the ETL wins. Its choices carry measured reasoning
(`STROKES` excludes spin because Ganser et al. could not separate it at 1660 Hz,
let alone 30 fps; frame identity is `source_ms` because `user-edit.json` is
written by a different process at a different time). The app's vocabulary came
from a design mock and has no such backing.

Rejected alternatives:

- **Rewrite the app's types to be `SwingDoc`-shaped.** Touches every component
  and the store for a data source that is one video deep. Premature.
- **Teach the ETL to emit app-shaped JSON.** Puts UI concerns in the ETL and
  breaks "a swing directory stands alone".

## Architecture

```
out/<session>/                     tennisproc output, unchanged
   metadata.json                   session doc
   swings/swing_NNN/
     metadata.json                 SwingDoc, ETL-owned
     user-edit.json                written by the app  <-- new
     frames/frame_NNNN.jpg         served as thumbnails <-- new

vite dev middleware  (new, dev only)
   GET  /api/session               session doc + swing docs
   GET  /api/media/<...>           frames/*.jpg, clip.mp4
   PUT  /api/swings/<dir>/user-edit  writes user-edit.json

src/domain/etl.ts    (new)         SwingDoc  -> Clip     (read adapter)
src/domain/etl-write.ts (new)      Clip      -> SwingDoc (write adapter)
src/state/store.ts                 hydrates from /api/session, falls back to seed
```

Four units, each independently testable:

1. **read adapter** — pure function, `SwingDoc[] -> Clip[]`. No I/O.
2. **write adapter** — pure function, `Clip -> SwingDoc`. No I/O.
3. **dev middleware** — I/O only, no schema knowledge beyond path safety.
4. **hydration** — startup effect that swaps seed for real data, or keeps seed.

Keeping the adapters pure is what lets them be tested against a real captured
fixture without a server or a browser.

## Field mapping

| `Clip` field | Source | Notes |
|---|---|---|
| `id` | `id` | `IMG_0304/swing_001`, already unique |
| `player` | `labels.player_name ?? labels.player_slot` | slot is a court zone, not a person; shown until a human names them |
| `stroke` | `labels.stroke` | `null` until a human labels it — see "Unlabelled strokes" |
| `rejected` | `!detection.verified` or `labels.verdict` in {`false_positive`, `duplicate`} | |
| `triaged` | `edit?.reviewed === true` | the ETL's own "a human has been here" bit |
| `grade` | `labels.quality` | 1–5 -> `work`/`ok`/`good`, see below |
| `note` | `labels.notes ?? ''` | |
| `duration` | `trim.source_end_ms - trim.source_start_ms` | formatted `m:ss` |
| `frames[]` | every frame in `frames[]`, in source order | see "Frame identity and sampling" |

`quality` (1–5) to `grade` (3 values) is lossy in both directions. Mapping:
1–2 -> `work`, 3 -> `ok`, 4–5 -> `good`; writing back emits 2/3/4. A swing
**a human re-rates** whose quality was 1 therefore round-trips to 2. This is
accepted: the alternative is widening the app's rating vocabulary, which is a
design change, not a plumbing one. The lossiness is recorded here so it is not
rediscovered as a bug.

A rating a human has *not* touched is written back unchanged — a 5 stays 5, a 1
stays 1. Applying a lossy projection to a value nobody edited is degradation, not
a mapping, and because a non-null value wins in `overlay()` it could not be undone
by re-reading. `toUserEdit` therefore compares the clip against the document it
was read from and writes each label back verbatim unless the reviewer changed it.
The same rule preserves `verdict` (`duplicate`, `unclear` and `null` all survive an
untouched load), `notes`, per-frame `stage` (including `other`), and `player_name`
(which stays `null` on a swing nobody has named, rather than being filled in with
the court slot — a slot is a court zone, not a person, on the write path as well as
the read path). See §1–§4 of the follow-ups companion for what this replaced.

## Frame identity and sampling

`Frame` gains `sourceMs: number`. `i` remains the render and selection index;
`sourceMs` is the join key for write-back. Dropping it would mean joining
`user-edit.json` on array position, which the ETL's schema doctrine explicitly
forbids — after any `--fps` change a human's contact label would land on a
different moment.

**A `Clip` carries every frame the ETL extracted.** `adaptSwing` does no
narrowing: `i` is a contiguous `0..n-1` render index over the full list and
`sourceMs` carries the real identity. This is the one place the two frame
vocabularies coexist, and it is why write-back joins on `sourceMs`.

Narrowing is the **compare grid's** concern alone. Real swings carry 42–49 stills
at ~33 ms, spanning ±800 ms around contact; a 42-row by ~90-column grid would need
virtualization and horizontal scrolling, and would lose the at-a-glance comparison
the view exists for. So `buildCompare` shows at most `FRAMES_PER_CLIP` cells per
row, windowed around that row's own anchor. The detail view, filmstrip and frame
inspector read the full list — which is what makes a reviewer able to tag setup or
finish at their real moments anywhere in the ±800 ms span.

Window rule (`frameWindow`, `src/domain/window.ts` — one definition, used by both
`buildCompare` and `sampleFrames`): a **contiguous** run of `min(width, n)` frames
centred on the anchor index, shifted inward at either end rather than shortened.
Two properties follow, and both matter:

- **The anchor is always inside the window.** That is what lets `buildCompare`
  align every row's anchor in one column.
- **Every row is the same width, even at the edges.** A clip whose contact sits at
  frame 1 or frame 47 still contributes 9 cells, so the grid does not develop
  ragged rows on the swings nearest the ends of their extraction.

Contiguity is deliberate: the grid labels its columns by offset from the anchor
(−2, −1, CONTACT, +1, …), which is only meaningful if neighbouring cells are
neighbouring stills. An earlier stride-based rule that resolved
`[-4..+4] x step` against `offset_contact_ms` could pick the same frame twice on a
sparse swing and yield short rows; a contiguous slice of a list the schema already
requires to be strictly increasing cannot.

`cell.frame` remains an index into the clip's **full** frame list, not a position
within the window, so clicking a cell selects the real still and write-back lands
on the right `source_ms`.

An untagged clip anchors on the middle of its extraction rather than a fixed index,
because the ETL centres extraction on contact — so the midpoint is the best
available guess at the moment the tagged clips are aligned on.

`FRAMES_PER_CLIP` stays 9 and its comment now says explicitly that it is the
compare-window width, not a per-clip truth. The seed builds 9-frame clips, so
windowing is the identity on it and the seeded view renders exactly as before.

## Unlabelled strokes

Every ETL stroke ships `null` — classification is deliberately out of scope for
the pipeline. The app's `Stroke` type is non-nullable and `strokeHue()` expects a
member of the enum.

`Stroke` becomes `Stroke | null` on `Clip`. `null` renders as an "untagged" chip
and is the signal a reviewer should act. This is the honest representation: the
alternative is inventing a default stroke the ETL never claimed, which would make
42 unlabelled swings look like 42 forehands.

Enum changes:

- add `overhead` and `other` — the ETL can emit them and the app currently cannot display them
- remove `Slice` — nothing can produce it, by explicit ETL design
- casing normalised in the adapter only; the app keeps its capitalised display forms

Making `stroke` nullable touches five existing call sites, all of which need a
decision rather than a `!`:

| Site | Handling |
|---|---|
| `grades.ts:25` `strokeHue` | already `?? 'gray'`; takes `string \| null` |
| `shared.tsx:241`, `DetailView.tsx:51` | render "untagged" instead of the raw value |
| `shared.tsx:229`, `DetailView.tsx:227` | `Select value` takes `''` for null so the dropdown opens unselected |
| `selectors.ts:49` stroke filter | `null` matches only `ALL_STROKES` |
| `selectors.ts:118` `strokesOf` | drop `null` from the filter options, so the dropdown never offers "untagged" as a filter |

Stage `other` maps to phase `null`. The app's three phases are the ones the
compare view can anchor on; `other` means "tagged, but not a phase boundary",
which is indistinguishable from untagged for alignment purposes.

## Per-frame confidence is dropped, not synthesised

`Frame.conf` drives the yellow "classifier is unsure about this frame" dot via
`CONFIDENCE_FLOOR`. The ETL has no classifier and therefore no such number.
`pose_score` is the pose detector's landmark quality — a different quantity, and
under the current defaults it is `null` on roughly 21 of 49 frames because the
pose window is narrower than the frame span.

Mapping `pose_score` onto `conf` would make the dot assert something false.
Instead `conf` becomes optional on `Frame`. For ETL clips `flagged` means "no
stroke label yet"; the seed keeps its own `conf` and its existing behaviour. The
tooltip text changes to match what the dot now means.

## Transport: dev middleware over the `out/` tree

A vite dev-server middleware serves the real tree. No export step, so the app is
always reading current ETL output.

- `GET /api/session` — session doc plus every swing doc, with `user-edit.json`
  overlaid where present, in one response. One request per load rather than 43.
- `GET /api/media/<session>/<dir>/frames/frame_NNNN.jpg` — thumbnails and clips.
- `PUT /api/swings/<session>/<dir>/user-edit` — write-back.

The tree root comes from an env var (`SHOT_LAB_OUT`), defaulting to `./out`. All
paths are resolved and confirmed to sit inside that root before any read or
write, so a traversal in a request cannot escape it. Writes are restricted to
files named `user-edit.json` inside a directory matching
`<session>/swings/swing_NNN`, and the write target is rejected if it is a
symlink — constraining the filename alone is not enough, because the final path
component is still followed, so a planted `user-edit.json -> metadata.json` link
would otherwise let the route corrupt ETL output. With all three checks the
middleware will not overwrite `metadata.json` under any request, which preserves
the ETL's "re-runnable without destroying human work" property at the transport
layer as well as by convention.

This is dev-only, and the app must still work without it: on a failed fetch the
store keeps the seed. That keeps `vite build`, `vite preview` and the existing
test suite green, and means a missing `out/` is a normal state rather than an
error.

## Thumbnails

`FrameTile` is the single insertion point — the compare grid, filmstrip and frame
grid all render through it at three sizes. It gains an optional `imageUrl`; when
present it renders an `<img>` behind the existing badges, when absent it renders
exactly as today. The seed passes nothing and is visually unchanged.

`loading="lazy"` and `decoding="async"`, because a 42-swing session at 9 visible
frames is ~378 images on one screen.

**Known caveat:** the current `out/` tree was produced with
`--pose-backend=stub`, because MediaPipe aborts without a GUI session on this
machine. Crop rectangles come from synthetic pose boxes, so real thumbnails will
be badly framed (mostly ceiling in the sample inspected). The plumbing is
correct; the framing is unproven until pose runs for real. This is a pre-existing
ETL limitation, already documented in `tennisproc/README.md`, and is not
something this change can fix.

## Write-back

On edit, the app `PUT`s a complete `SwingDoc` to the middleware, which writes
`user-edit.json` beside the swing's `metadata.json`.

- Whole document, not a patch — `user-edit.json` is the same schema as
  `metadata.json` and one validator serves both.
- ETL-owned blocks (`source`, `trim`, `crop`, `detection`, `measurements`) are
  echoed unchanged from the metadata the app read. `overlay()` ignores them from
  the edit side regardless, but writing them keeps the file a valid standalone
  `SwingDoc`.
- `frames[]` carries `source_ms` and `stage`; the join happens on `source_ms`.
  Every frame the clip carries is written, which for an ETL-loaded clip is all
  42–49 — so a stage tagged anywhere in the span survives, not just one inside the
  compare window. A frame the clip does *not* carry is omitted entirely rather than
  written with a null stage, so it keeps whatever stage it had.
- **The projection is a fixed point.** A page load followed by no user action
  writes back bytes identical to what is already on disk apart from `edit.at`.
  This is what makes a *second* review pass over the same tree safe, and it is why
  every field above is written from the source unless the reviewer changed it.
  Verified over the real 42-swing tree; see §1 of the follow-ups companion.
- `edit` is `{by, at, against, reviewed}`. `against` is the `doc_hash` of the
  metadata the app read, so a later `overlay()` can report that a human reviewed
  a stale ETL output. The app cannot compute the Python hash itself, so
  `/api/session` returns each swing's `doc_hash` alongside its document.
- Debounced, and last-write-wins per swing. Two reviewers on one tree is out of
  scope.

## Testing

The strategy follows what each unit is: pure functions get unit tests, and the
round trip gets checked by the tool that owns the schema.

| Unit | How |
|---|---|
| read adapter | vitest against a real captured `metadata.json` committed as a fixture — not a hand-written object, so it stays honest about what the ETL actually emits |
| frame carry-through | `adaptSwing` on the real fixture yields all 49 frames, and a stage tagged on any of them survives write-back |
| windowing | the anchor lands in the same column for every row; a 42-, 47- and 49-frame swing all yield 9 cells; `cell.frame` still indexes the full list |
| round-trip fixed point | read a rich `user-edit.json`, write it straight back, and the bytes match apart from `edit.at` — checked per field, end to end over the transport, at the store's write-back effect, and from the ETL side by `overlay()` |
| enum mapping | every ETL stroke and stage maps to something renderable; `null` stroke stays `null` |
| write adapter | output passes `schema.validate_swing` — asserted by running the Python validator over what the adapter produced, not by a TS mirror of the rules |
| round trip | `tennisproc validate` and `tennisproc show` over an `out/` tree the app has written; `show` must display the app's labels |
| middleware | path traversal is rejected; `metadata.json` cannot be overwritten |
| fallback | with no `/api/session`, the store still seeds and all existing tests pass |

The write-adapter and round-trip tests deliberately cross the language boundary.
A TypeScript assertion that the app's output "looks valid" would re-implement the
validator and could drift from it; running `schema.py` is the only check that
cannot.

## Out of scope

- **Classification.** Strokes and stages stay human-filled. A classifier can
  land later writing the same fields.
- **Production transport.** Dev middleware only. A static deployment reading real
  sessions needs a real server, which is a separate decision.
- **Multi-session browsing.** One `out/<session>` tree at a time.
- **Concurrent reviewers.** Last write wins.
- **Re-crop or re-render.** The app reads what the ETL produced; fixing crop
  framing means running real pose, not changing the app.

## Landing order

The four units are separable, and each step leaves the app working. If the change
needs to be cut short, the earlier steps still have standalone value.

1. **Read adapter + fixture tests.** No app behaviour changes; the seam is proven
   against real captured output. De-risks everything after it.
2. **Dev middleware (read) + hydration.** The app now shows real swings, with the
   seed as fallback. This is the point where "the UI runs on ETL output" is true.
3. **Thumbnails.** Visible payoff, and the caveat about stub-pose framing applies.
4. **Write-back.** Closes the loop; verified by the Python validator.

## Risks

| Risk | Mitigation |
|---|---|
| Thumbnails look wrong (stub-pose crops) | documented above; framing is an ETL data problem, verified separately when pose can run |
| `quality` <-> `grade` is lossy | mapping fixed and documented; applies only to a grade a human set, so no silent re-rating |
| Sampling hides frames a reviewer needs | a `Clip` carries all 42–49 and the detail view renders them; windowing only narrows the compare grid |
| Write-back degrades a previous pass's labels | the projection is a fixed point: an untouched field is written back from the source verbatim, so a bare load rewrites the file byte-identically |
| Dev-only transport reads as "done" | fallback to seed is explicit, and this section is the record that production transport is unbuilt |
| Write-back corrupts ETL output | middleware refuses to write anything but `user-edit.json`, only inside `<session>/swings/swing_NNN`, and never through a symlink at the target; ETL only ever writes `metadata.json` |
