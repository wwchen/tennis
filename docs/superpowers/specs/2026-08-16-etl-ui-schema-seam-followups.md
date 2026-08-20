# ETL → UI seam: known gaps after the first landing

Companion to [`2026-08-16-etl-ui-schema-seam-design.md`](2026-08-16-etl-ui-schema-seam-design.md).
Everything here was found by review, verified by running it, and deliberately
deferred rather than rushed in unreviewed. Ordered by what to fix first.

§1–§4 are **fixed**, and §7–§9 below record a later adversarial review that found
§1's "a second pass is safe" claim was still **too strong** — three further
destructive paths survived it, all now fixed. They are kept struck through where
fixed, because the reasoning is what makes the current design legible — and
because §1 in particular is the kind of bug that only appears when four
individually-harmless mappings compose. §12 then fixed two of §11's six bullets —
the two that, like §1, let a write with no user action overwrite something only a
human should change — and §13 fixed a third, the one where the READ path failed
whole-session on a single bad document. §5, §6 and the remaining three §11 bullets
are still open.

## ~~1. Write-back fires on page load and degrades existing labels~~ (blocking a second review pass)

**FIXED**, but the original claim here was too strong — see §7–§9. The load-time
write-back still fires — that was never the defect — but the projection is now a
fixed point, so what it writes is byte-identical to what is already on disk apart
from `edit.at`. A second review pass over the same tree is safe *for documents
this app version wrote*; §7 was the case where it was not (a document whose frame
grid came from a different `--fps`).

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

## ~~7. A bare load permanently destroyed stage tags `overlay()` preserves on purpose~~

**FIXED.** The most serious of the three findings that refuted §1's "a second pass
is safe" claim, because it destroyed a human's work with **no user action at all**.

`overlay()` (`tennisproc/schema.py:439`) drops a frame whose `source_ms` is absent
from `metadata.json` **from the merged view** and warns — deliberately, leaving it
**on disk**, so re-running the ETL back at the original `--fps` recovers whatever a
human tagged there. `toUserEdit` built its frame list by filtering `source.frames`,
but `source` **is** that merged view, so the orphan was already gone from it; the
load-time write-back then wrote the filtered list back and erased it from disk
permanently. Directly contrary to `tennisproc/README.md`'s "stable keys, never
array indices" doctrine.

The fix needs the previous **unmerged** `user-edit.json`, which the merged doc can
no longer describe, so `SwingEntry` grew an `edit` field: the dev middleware
already reads that file and now returns it alongside `doc`. `toUserEdit` takes it
as an optional last argument and re-attaches any entry whose `source_ms` the
metadata does not know, then sorts by `source_ms` (`schema.py:206` requires the
list strictly increasing). `etl.ts` and `etl-write.ts` stay pure.

Only orphans carrying a **stage** are kept. An orphan's `file` names a still the
current extraction never wrote, and `session.validate_tree` reports a frame whose
file is missing, so preserving a stage-less orphan would trade a silent data loss
for a permanent validation complaint about an entry holding no human work. A stage
is the only thing on a frame a reviewer can author, and `overlay()` ignores a null
stage anyway.

Verified on the real tree: a tag on `source_ms=6317` (between two real frames, so
no `--fps` grid contains both) survives a load-only write; the ETL then reports the
file valid, warns exactly once, and the tag is still on disk. Separately, a full
42-swing review pass followed by two bare reloads leaves all 42 files
byte-identical apart from `edit.at`, with `validate_tree` reporting **85 documents,
0 problems**, 0 overlay warnings, and all 84 stage tags intact.

## ~~8. An unverified swing's reject state never converged~~

**FIXED.** `isRejected` ORed in `!detection.verified`, which is ETL-owned and the
app cannot clear — so an unverified swing *always* read as rejected: "restore"
wrote `valid`, the next load re-rejected it, and a subsequent "remove" wrote
`valid` **again**, filing the reviewer's rejection as an acceptance.

A human's verdict is now authoritative over `detection.verified` for display, so
the two can disagree and the machine settles. The truth table is in the comment on
`isRejected` (`src/domain/etl.ts`); the load-bearing rows are `valid` +
`verified: false` → **not** rejected (the row that converges) and `null` +
`verified: false` → **still** rejected (the ETL's own meaning, preserved).

## ~~9. The compare grid misaligned CONTACT on real data~~

**FIXED.** `anchorIndex` fell back to the frame-list midpoint for a clip with no
anchor tag — and every real ETL frame ships `stage: null`, so **all 42 swings took
that path**. The midpoint is not contact: `render.py` truncates extraction at the
video boundaries, so a swing near either end of the source is not centred on it.
Measured on the sample tree: swing_041 off by 1 frame, swing_042 off by 4
(~133 ms), silently, with nothing on screen to indicate it.

`Frame` now carries `offsetContactMs`, and the `contact` anchor uses
`offsetContactMs === 0` — the ETL's own answer, already in the data. A human's tag
still wins over it. The midpoint survives only as the last resort, for
`setup`/`finish` (which have no ETL equivalent) and for seeded clips (no detector).
Verified over all 42 real swings: every CONTACT column is the true contact frame,
and all 42 rows align in one column.

Also fixed alongside, both consequences of the frame list growing from 9 to ~49:
the detail scrubber is clamped to [0, 100] (observed `width: 117%`), and the clock
formats as `m:ss` from real frame timing rather than `0:0${frame/4}`, which
rendered `0:010`–`0:012` for frames 38-49. Both live in `src/components/playback.ts`
so `DetailView.tsx` keeps exporting only its component. `openDetail` also resets
`ui.sel` when the detail target changes, so opening a different clip no longer
ghost-highlights a frame index carried over from the previous one.

## ~~10. Two tests asserted nothing~~

**FIXED.** Both were found by the same review, and both passed against code that
had the defect they claimed to cover.

`tests/test_app_writeback.py`'s "fixed point" test never called the TypeScript
projection: it fed a document to itself, and `schema.doc_hash` **excludes** `edit`,
so the hash equality was a tautology — it passed verbatim on a fully degraded
document (confirmed: quality 4, verdict `false_positive`, `player_name: "left"`,
9 frames). Its label assertions only read back values it had hardcoded twenty lines
earlier. It is replaced by a falsifiable cross-language check: the document the
**old lossy projection** would have produced must differ from the preserved one on
every field the §1 table names, only the lossy one loses the human's labels through
`overlay()`, and only the preserved one survives with all 49 frames and both far
stage tags. A companion test pins the ETL half of §7's contract.

Two neighbouring tests derived their cases from the constant under test
(`for verdict in schema.VERDICTS`), so shrinking the vocabulary back to the old
lossy set still passed. They now also assert `"duplicate" in schema.VERDICTS` and
`1 in schema.QUALITY` explicitly.

`notesFor` had **zero** coverage — deleting it entirely caused 0 failures, because
the fixture has `notes: null` and `clip.note` is `''`, where old and new agree. The
case it exists for is an on-disk `notes: ''`, which must round-trip as `''` rather
than collapsing to null; that and the converse (a human clearing a real note writes
`null`) are now asserted.

## 11. Still open, found by the same review

Recorded rather than fixed, to keep this pass reviewable. None destroys data
without a user action.

The first and fourth bullets are now **fixed** (§12). The rest remain open.

- ~~**`edit.by` and `edit.against` are not preserved** (I4). `by` is hardcoded
  `"reviewer"`, overwriting a real name; `against` is rewritten to the current
  hash, erasing the stale-review marker `overlay()` warns on. Both are
  counterexamples to "byte-identical apart from `edit.at`" for a file written by
  another tool or reviewer.~~ **FIXED** — see §12.
- **`undoRemove` invents a verdict** (M1/I1). A round-trip toggle rewrites the
  verdict it read: `duplicate` → restore → remove lands on `false_positive`, and
  `null` → remove → restore lands on `valid` — an accept call no human made,
  reachable in two clicks.
- **Duplicate `source_ms` in an incoming edit** (M2) is not rejected on the read
  path, though `schema.py:206` forbids it, so a hand-edited file can make a stage
  ambiguous.
- ~~**Non-string `tags`** (I3) are echoed by spread with no validation, so
  `toUserEdit` can emit a document `validate_swing` rejects.~~ **FIXED** — see
  §12, which also covers every other label field the same spread exposed.
- **The detail filmstrip renders 0 of ~49 images** — `DetailView` builds its cell
  without `imageUrl`. Pre-existing, and a design question (the filmstrip may be
  intended as a painted index rather than a contact sheet) rather than a bug fix,
  so deliberately untouched. It does falsify the earlier report's claim that the
  detail view lazily requests up to 49 stills.
- ~~**A malformed `metadata.json` makes a whole session read as absent.** Found
  while hardening the write path (§12). `strokeToApp` calls `.charAt` on
  `labels.stroke`, so a non-string value throws inside `adaptSwing`, and
  `loadEtlClips` catches everything and returns `null` — which is the "there is no
  tree" signal. One malformed swing therefore silently drops all 42, and the
  reviewer sees the seed with no indication why.~~ **FIXED** — see §13.

## 12. Attribution, staleness, and label validity (§11 bullets 1 and 4)

**FIXED.** Both were the same shape of bug as §1: the load-time write-back, which
fires with **no user action**, rewriting something only a human should change.

### `edit.by` and `edit.against` (I4)

`by` was hardcoded and `against` was always the current `entry.hash`. So a bare
page load over a `user-edit.json` written by `coach-ana` against an older render
rewrote it to `by: "reviewer", against: <current>` — laundering the attribution
and, worse, **erasing the stale-review marker**. `against` records *which ETL
output was reviewed*, and it exists so `overlay()` can warn "stale edit: reviewed
against X but metadata is Y" (`schema.py:419`). Overwriting it with the current
hash makes a genuinely stale review silently claim to be current, which is worse
than the stale review itself.

Now, in `editFor` (`src/domain/etl-write.ts`): if the human changed nothing, `by`
and `against` come from `prevEdit` verbatim; if they did, the write is genuinely
theirs and both are this write's own. `at` is always this write's clock either way.

**How "the human changed something" is decided.** Derived from the projection, not
from a flag. Every `*For` helper already answers, field by field, "does the clip
disagree with what the read adapter would have derived from `source`?" — and each
returns `source`'s own value verbatim when it does not. So *changed nothing* is
exactly *every projected field is identical to the one it came from*, which is the
same identity the §1 fixed-point tests already pin. A flag threaded from the UI
would be a second, independent answer to a question the projection must answer
anyway, free to drift from it.

**Two consequences worth noting.** Sanitisation runs *after* that comparison —
repairing a malformed file is not a review, so it must not re-stamp `by`. And the
dedup cache key changed: it used to strip `edit` entirely, which was sound only
while `edit` was a pure function of the payload. It no longer is, and sanitising
can collapse two projections that disagree about attribution onto identical
`labels` (an illegal `quality: 9` writes as `null` whether preserved or cleared by
a reviewer). The key now includes `edit` with only `at` blanked.

### Non-string `tags`, and every other field the same spread exposed (I3)

`toUserEdit` spreads `...source.labels`, and `source` came out of `overlay()`,
which lifts `labels` out of `user-edit.json` field by field with **no validation at
all** (`schema.py:424`). So *anything* the projection did not itself compute was
echoed straight back, and `tags: [1, null]` or `tags: "backhand"` made the app
emit a document its own `validate_swing` rejects.

`sanitiseLabels` now forces the block into something the validator accepts:

- **`tags`** — non-string entries are **dropped**, valid ones around them kept.
  Not coerced: `String(1)` invents the tag `"1"` nobody wrote, and a non-empty list
  *wins* in `overlay()`, so the fabrication would be unremovable by re-reading. A
  non-array or absent `tags` becomes `[]`, which is also the one value `overlay()`
  treats as "no opinion", so it cannot erase a list `metadata.json` carries.
- **Every other label field** was exposed identically, and all are fixed here
  because the fix is the same one line each: `stroke`, `verdict` and `player_slot`
  outside their enums, a `quality` outside 1–5 (including a float, and a bool —
  `schema.py`'s `_is` deliberately refuses `True` for an integer field), and a
  non-string `player_name`/`notes`. Each becomes `null`, which is what "no label
  here" already means. Deliberately **not** coerced towards a legal member:
  `stroke: "Backhand"` might plausibly mean `backhand`, but `quality: 9` has no
  defensible reading, and inventing one records a call no human made.
- **`frames[].stage`** too, which was the subtle one: `stageToPhase` folds only
  `null` and `other`, so `'wobble'` reached the clip *as a phase*, compared equal
  to itself, and round-tripped. Also guarded in `orphanedFrames`.

**`slice` deserves a mention**: it is deliberately absent from `STROKES` (spin is
not recoverable at 30 fps) and it survived the read path invisibly, because
`strokeToApp('slice')` is `'Slice'`, which compares equal to itself.

### One thing the ETL schema does not mean

`optional=True` in `_Check.field` reads as "this field may be absent", but that is
**not** what it does: `field()` reports `missing` and returns *before* it consults
`optional`, which governs only whether a null is accepted. So `edit.against: null`
validates and an **absent** `against` does not. The first implementation here had
it backwards — it omitted the key — and `tests/test_app_writeback.py`
(`test_an_absent_against_is_missing_but_null_is_legal`) now pins the real rule.
Write-back records an explicit `null` when the previous file had no `against`,
which says "nothing to compare" without claiming a fresh review.

### Verified

31 new vitest cases and 22 new Python cases, each shown to fail against the
pre-fix behaviour. Driven over the real 42-swing `IMG_0304` tree with a foreign,
malformed `user-edit.json` planted: `by` and `against` survived a bare load,
`tags` was repaired to `['reel']`, the reviewer's real `quality: 5` and notes were
untouched, `session.validate_tree` reported **0 problems across 44 documents**,
and the stale-edit warning still fired — the signal the fix exists to protect.

## 13. One malformed swing no longer costs the whole session (§11 bullet 6)

**FIXED.** `adaptSession` was a `.map`, so a throw anywhere in it was a throw for
the entire payload — and the only thing that catches it, `loadEtlClips`, returns
`null` for *every* failure. `null` is also the signal that means "there is no
`out/` tree", which the caller answers by keeping the seed. So one swing with a
non-string `stroke` (legal in no schema, but `overlay()` merges `labels` out of
`user-edit.json` field by field with no validation) dropped all 42 real swings and
put twelve fixture clips on screen in their place, silently.

Two halves, and the second is the load-bearing one:

- **Per-swing isolation.** `adaptSession` now loops, adapting each swing in its
  own `try`, and returns `{ clips, entries, skipped }`. A bad document costs its
  own swing. `entries` — the write-back loop's work list — is filtered to match,
  so a swing with no clip can never become a PUT target. The entry's `dir` is read
  *before* the `try`, because `swings` is JSON off disk and reporting the failure
  must not throw a second time inside the catch.
- **The count reaches the human.** `loadEtlClips` no longer conflates "unreadable"
  with "absent": a tree whose documents all fail now returns zero clips and a
  report, not `null`. `skipped` rides through `hydrate` into `State`, and
  `SkippedBanner` renders "N swings could not be read" in the header, with each
  `dir` and reason in its `title`. Without this half the fix would be a smaller
  version of the same bug — 41 of 42 swings still reading as a complete session.

`adaptSwing` still throws, deliberately. It is the boundary that knows what a
document must look like; making it return a partial clip instead would push
malformed values downstream into the write path, which is the class of defect §12
was about.

### Verified

13 new vitest cases (202 passing, up from 189), each watched failing first — the
banner's three against a renamed export, so the failure was the missing component
and not the module-resolution error a worktree produces. Covered: a malformed
swing between two good ones, a malformed swing first (media base must not shift
with the index), an all-malformed session, `entries` filtering, and an entry that
is not an object at all.

## Environmental limits, not code defects

- **Thumbnails are badly framed.** The `out/` tree used throughout was produced
  with `--pose-backend=stub`, because MediaPipe aborts without a GUI session
  (`CGMainDisplayID() == 0`). Crops come from synthetic pose boxes. The plumbing
  is correct; framing is unproven until pose runs for real.
- **Transport is dev-only.** A static deployment reading real sessions needs a
  real server. Out of scope by design, recorded so "dev works" is not mistaken
  for done.
