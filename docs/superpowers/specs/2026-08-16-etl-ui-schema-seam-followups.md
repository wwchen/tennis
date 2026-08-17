# ETL → UI seam: known gaps after the first landing

Companion to [`2026-08-16-etl-ui-schema-seam-design.md`](2026-08-16-etl-ui-schema-seam-design.md).
Everything here was found by review, verified by running it, and deliberately
deferred rather than rushed in unreviewed. Ordered by what to fix first.

## 1. Write-back fires on page load and degrades existing labels (blocking a second review pass)

**What happens.** `overlayEdit` carries the `edit` block through on read, so
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

## 2. The app sees only 9 of 42–49 frames

`adaptSwing` samples down to 9 frames before a `Clip` exists
(`src/domain/etl.ts`), and the detail view renders that same list. The spec
(§"Frame identity and sampling") claims the detail view reads the full list and
offers that as the mitigation for sampling — it does not.

Consequence: the reachable window is roughly ±133 ms of a ±800 ms extraction, so
a reviewer **cannot tag setup or finish at their real moments** on real footage.

Fix: carry all frames on `Clip` and let `buildCompare` sample. Sampling is a
compare-grid concern — `FRAMES_PER_CLIP`'s own comment already says so. This
changes the adapter's contract and every test asserting 9 frames, which is why it
was not folded into a fix wave.

## 3. Verdict round-trip loses information the spec never sanctioned

`src/domain/etl-write.ts` collapses verdict to a two-valued `rejected` boolean:

```
duplicate -> rejected=true  -> false_positive   ("duplicate" lost)
unclear   -> rejected=false -> valid            ("unclear" lost)
null      -> rejected=false -> valid            (asserts a verdict no human gave)
```

The spec sanctions exactly one lossy mapping (quality 1→`work`→2) and documents it
so it is not rediscovered as a bug. This is a second, undocumented one. The
`null → valid` case is the worst: non-null wins in `overlay()`, so the ETL's own
`null` is permanently overwritten on every triaged clip.

Also `gradeToQuality` can never emit 1 or 5, so those ratings are unreachable
through the app.

## 4. `player_name` is written as the court slot

`etl-write.ts` writes `player_name: clip.player`, and `clip.player` falls back to
`player_slot`. The spec is explicit that a slot is a court zone, not a person —
write-back defeats that by telling the ETL a human named this player "left".
Write `player_name` only when it differs from the slot.

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
