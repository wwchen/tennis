# ETL → UI seam: known gaps after the first landing

Companion to [`2026-08-16-etl-ui-schema-seam-design.md`](2026-08-16-etl-ui-schema-seam-design.md).
Everything here was found by review, verified by running it, and deliberately
deferred rather than rushed in unreviewed. Ordered by what to fix first.

§1–§4 are **fixed**. They are kept below, struck through, because the reasoning is
what makes the current design legible — and because §1 in particular is the kind
of bug that only appears when four individually-harmless mappings compose. §5 and
§6 remain open.

## ~~1. Write-back fires on page load and degrades existing labels~~ (blocking a second review pass)

**FIXED.** The load-time write-back still fires — that was never the defect — but
the projection is now a fixed point, so what it writes is byte-identical to what
is already on disk apart from `edit.at`. A second review pass over the same tree
is safe.

Verified over the real 42-swing `IMG_0304` tree: a rich first pass (stage tags on
frames 3 and 45, grades, strokes, notes, names, some rejections), then two bare
loads — all 42 files unchanged, and `session.validate_tree` reports 0 problems and
0 overlay warnings across all 85 documents.

Regression tests: `src/domain/etl-write.test.ts` ("load-only round trip is a fixed
point"), `vite-plugin-shot-lab.test.ts` ("rewrites a reviewer's own user-edit.json
byte-for-byte on a bare reload"), `src/state/store.test.ts` ("writes back a
previously-reviewed swing unchanged on a bare page load"), and
`tests/test_app_writeback.py` (`TestPreservedLabelsRoundTrip`).

<details><summary>What it used to do, and why it stayed invisible until the end</summary>

**What happened.** `overlayEdit` carries the `edit` block through on read, so
`adaptSwing` derives `triaged: true` for any swing that already has a
`user-edit.json`. The write-back effect (`src/state/store.ts:325`) is gated on
`triaged` and its dedup cache starts empty, so it PUTs every previously-reviewed
swing on load, with no human action — sending `toUserEdit`'s lossy projection
back over the reviewer's own richer file.

Measured on a real tree, from one bare page load:

| Written by a human | Comes back as |
|---|---|
| `quality: 5` | `quality: 4` |
| `verdict: "duplicate"` | `verdict: "false_positive"` |
| 49 frames, `stage: "setup"` on an early frame | 9 frames, that tag gone |
| `player_name: null` | `player_name: "left"` (the court slot) |

**Why it appeared only at the end.** Each lossiness below (§2–§4) was
individually harmless while nothing read `user-edit.json` back. Closing the read
loop made them destructive *together*. No per-task review could see it.

**Practical status.** Safe for a *first* review pass over a fresh ETL tree — there
are no existing edits to degrade. Unsafe for a *second* pass over the same tree.

**The fix is §2–§4, not a guard.** Suppressing the load-time write (e.g. priming
the dedup cache at hydrate) hides the symptom and leaves the same degradation on
the reviewer's first real edit. Make the projection non-lossy instead.
</details>

## ~~2. The app sees only 9 of 42–49 frames~~

**FIXED.** `adaptSwing` maps every frame in `doc.frames` onto `Clip.frames` in
source order, with `i` a contiguous render index over the full list and `sourceMs`
the identity `user-edit.json` joins on. The narrowing moved to `buildCompare`,
which windows each row around that row's own anchor via `frameWindow`
(`src/domain/window.ts`) — one definition of the window, shared with
`sampleFrames`. `cell.frame` stays an index into the FULL list, so a click still
selects the real still. `FRAMES_PER_CLIP` stays 9 and now says explicitly that it
means "compare-window width", not a per-clip truth.

The window is contiguous and shifts inward at either edge rather than shortening,
so a clip whose contact sits at frame 1 or 47 still gets 9 columns. An untagged
clip anchors on the middle of its extraction rather than a fixed index 4, because
the ETL centres extraction on contact.

Consequently the design spec's claim that **the detail view reads the full frame
list is now true** — it was the stated mitigation for sampling, and it now holds.

<details><summary>What it used to do</summary>

`adaptSwing` sampled down to 9 frames before a `Clip` existed, and the detail view
rendered that same list, so the reachable window was roughly ±133 ms of a ±800 ms
extraction and a reviewer **could not tag setup or finish at their real moments**
on real footage. 40 of 49 stills were unreachable, and write-back silently dropped
whatever stages they carried.
</details>

## ~~3. Verdict round-trip loses information the spec never sanctioned~~

**FIXED.** `toUserEdit` takes `source` — the document the clip was read from — as
the reference for "unchanged", and writes each label back verbatim unless the clip
disagrees with what `adaptSwing` would have derived from it:

```
verdict, unchanged     -> the source's own verdict: duplicate stays duplicate,
                          unclear stays unclear, and a null the ETL left stays
                          null rather than becoming an accept call no human gave
newly rejected         -> false_positive (the only rejecting verdict the app can
                          mean on its own)
newly un-rejected      -> valid (the human made an accept call, and leaving
                          `duplicate` would re-hide the clip on the next load)
```

"Unchanged" is measured with `isRejected()`, exported from `etl.ts` and shared with
`adaptSwing` so both sides apply one rule — including `detection.verified`, which
rejects a clip independently of any verdict. Without that, every unverified swing
would read as newly un-rejected and get stamped `valid`.

The same rule now covers `quality` (an untouched 5 stays 5, an untouched 1 stays
1), `notes` (an untouched null stays null rather than becoming `""`, since
`adaptSwing` reads null as `''` for the textarea to bind), and per-frame `stage`
(an untouched `other` stays `other` rather than folding to null).

`gradeToQuality` still emits only 2/3/4, so **quality 1 → `work` → 2 remains the
one lossy mapping the design spec sanctions**. What changed is that it now applies
only to a grade a human actually set, never to one merely read back.

The reference is taken from `source` rather than carried on the `Clip` on purpose:
it needs no new field on `Clip`, it compares against what is on disk *now* rather
than at page load, and it cannot end up persisted into localStorage as if it were
coaching data.

## ~~4. `player_name` is written as the court slot~~

**FIXED.** `toUserEdit` writes `player_name` only when `clip.player` differs from
what `adaptSwing` would have derived from the source — `playerOf()`: the name, else
the slot, else `'unassigned'`. A swing nobody has named writes `null`, and
`player_slot` is left alone. A slot stays a court zone, not a person.

## 5. Write target: hardlinks and symlinked swing directories

`resolveWriteTarget` rejects a symlink *at* the target, but:

- a **hardlink** (`ln metadata.json user-edit.json`) is not a symlink, and writing
  through it replaces `metadata.json`;
- a symlinked *directory component* (`swings/swing_001 -> ../work`) passes
  containment and lands the write outside any swing directory.

Both need write access to the ETL's own tree already, so severity is low. But the
spec's transport section states the guarantee absolutely; either narrow that
wording or compare the resolved parent against the request path.

## 6. Cosmetic and hygiene

- **Frame-number legibility.** `rgba(250,249,233,0.62)` with no text-shadow
  disappears over a bright still — and the current stub-pose crops are mostly
  ceiling. One line: `textShadow: '0 1px 2px rgba(0,0,0,0.7)'`.
- **`alt="" role="presentation"` on frame stills.** In a frame-review tool the
  photo is the content, not decoration. Prefer `alt={`Frame ${cell.num}`}` and
  query by `img` in the test, which also decouples the test from the role.
- **Dead code.** `mediaUrlFor` (`etl.ts`) is exported and never called while
  `adaptSession` inlines the same template; `EtlSessionDoc`/`EtlSwingRef` are
  unused; `Clip.conf` is optional and read nowhere.
- **Untagged-state opacity** is redundant with the literal "untagged" text and
  conveys nothing to a screen reader.

## Environmental limits, not code defects

- **Thumbnails are badly framed.** The `out/` tree used throughout was produced
  with `--pose-backend=stub`, because MediaPipe aborts without a GUI session
  (`CGMainDisplayID() == 0`). Crops come from synthetic pose boxes. The plumbing
  is correct; framing is unproven until pose runs for real.
- **Transport is dev-only.** A static deployment reading real sessions needs a
  real server. Out of scope by design, recorded so "dev works" is not mistaken
  for done.
