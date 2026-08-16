# ETL → UI Schema Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the React review app read real `tennisproc` output from `out/` and write reviewer labels back to `user-edit.json`.

**Architecture:** A pure read adapter converts `SwingDoc` → `Clip`; a pure write adapter converts back. A vite dev middleware serves the `out/` tree and accepts write-back. The app hydrates from the middleware at startup and falls back to the existing seed when it is absent, so the static build and current tests stay green.

**Tech Stack:** TypeScript, React 19, vite 8, vitest 4 (jsdom), Python 3.13 stdlib `unittest` for cross-boundary validation.

**Spec:** `docs/superpowers/specs/2026-08-16-etl-ui-schema-seam-design.md`

## Global Constraints

- The ETL schema is authoritative. Where vocabularies disagree, the ETL wins.
- The app writes **only** files named `user-edit.json`. It never writes `metadata.json`, `pose.json`, `clip.mp4`, or `frames/`.
- Frame identity for any join is `source_ms`, never an array index.
- `out/` root comes from `SHOT_LAB_OUT`, defaulting to `./out`.
- A missing/unreachable `out/` tree is a normal state: the app keeps the seed.
- Middleware is **dev only**. `vite build` and `vite preview` must not depend on it.
- Node `>=22.12.0`; no new runtime dependencies (`package.json` deps stay as-is).
- Lint rules in force: `@typescript-eslint/consistent-type-imports`, `eqeqeq`, `no-console` (only `warn`/`error` allowed).
- Run `npm run typecheck && npm run lint && npm test` before every commit.
- Python suite: `.venv313/bin/python -m unittest discover -s tests` (286 tests currently pass).

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `src/domain/__fixtures__/swing-real.json` | Real captured `SwingDoc` (49 frames), already committed by Task 1 | 1 |
| `src/domain/etl-types.ts` | TypeScript mirror of the ETL's JSON shapes. Types only, no logic. | 1 |
| `src/domain/etl.ts` | Read adapter: `SwingDoc[] → Clip[]`, incl. frame sampling. Pure. | 2, 3 |
| `src/domain/etl.test.ts` | Read-adapter tests against the real fixture. | 2, 3 |
| `src/domain/types.ts` | `Frame.sourceMs`, nullable `stroke`, optional `conf`, enum changes. | 2 |
| `src/domain/grades.ts` | `strokeHue` accepts `string \| null`; hue for new strokes. | 2 |
| `src/lib/selectors.ts` | Null-stroke handling in filter + `strokesOf`. | 2 |
| `src/components/shared.tsx` | `FrameTile` `imageUrl`; untagged-stroke rendering. | 4, 6 |
| `src/components/DetailView.tsx` | Untagged-stroke rendering. | 4 |
| `vite-plugin-shot-lab.ts` | Dev middleware: session read, media, write-back. | 5, 7 |
| `vite.config.ts` | Register the plugin. | 5 |
| `src/state/etl-source.ts` | `fetch` wrapper + fallback. The only I/O in `src/`. | 5 |
| `src/state/store.ts` | Hydration action + write-back effect. | 5, 7 |
| `src/domain/etl-write.ts` | Write adapter: `Clip → SwingDoc`. Pure. | 7 |
| `tests/test_app_writeback.py` | Validates app-written `user-edit.json` with `schema.py`. | 7 |

---

## Task 1: ETL type mirror and real fixture

**Files:**
- Create: `src/domain/etl-types.ts`
- Create: `src/domain/__fixtures__/swing-real.json` (already staged on disk; commit it here)
- Test: none — types only; Task 2 exercises them.

**Interfaces:**
- Consumes: nothing.
- Produces: `EtlSwingDoc`, `EtlFrame`, `EtlLabels`, `EtlSessionDoc`, `EtlSwingRef`, `EtlStroke`, `EtlStage`, `EtlVerdict`, `EtlPlayerSlot`, `SessionPayload`.

- [ ] **Step 1: Confirm the fixture is real captured ETL output**

Run:
```bash
cd /Users/wc/code/github/wwchen/tennis2
python3 -c "import json;d=json.load(open('src/domain/__fixtures__/swing-real.json'));print(d['id'],len(d['frames']),d['detection']['contact_ms'])"
```
Expected: `IMG_0304/swing_001 49 6301`

If the file is missing, regenerate it from a real run:
`cp out/IMG_0304/swings/swing_001/metadata.json src/domain/__fixtures__/swing-real.json`

- [ ] **Step 2: Write the type mirror**

Create `src/domain/etl-types.ts`:

```ts
/**
 * TypeScript mirror of the shapes `tennisproc` writes. Field names are
 * snake_case because these describe JSON on disk, not app values — the
 * boundary where they become camelCase is `etl.ts`.
 *
 * Enums are duplicated from `tennisproc/schema.py`, which owns them. Keep in
 * step with STAGES / STROKES / VERDICTS / PLAYER_SLOTS there.
 */

export type EtlStage = 'setup' | 'contact' | 'finish' | 'other';

export type EtlStroke =
  | 'forehand'
  | 'backhand'
  | 'volley'
  | 'serve'
  | 'overhead'
  | 'other';

export type EtlVerdict = 'valid' | 'false_positive' | 'duplicate' | 'unclear';

export type EtlPlayerSlot = 'left' | 'right' | 'near' | 'far';

export interface EtlFrame {
  file: string;
  source_ms: number;
  clip_ms: number;
  offset_contact_ms: number;
  /** Null on frames outside the pose window — normal, not an error. */
  pose_score: number | null;
  stage: EtlStage | null;
}

export interface EtlLabels {
  player_slot: EtlPlayerSlot;
  player_name: string | null;
  stroke: EtlStroke | null;
  quality: 1 | 2 | 3 | 4 | 5 | null;
  verdict: EtlVerdict | null;
  tags: string[];
  notes: string | null;
}

export interface EtlTrim {
  file: string;
  source_start_ms: number;
  source_end_ms: number;
  encoded_start_ms: number;
  width: number;
  height: number;
}

export interface EtlDetection {
  method: string;
  contact_ms: number;
  onset_peak: number | null;
  verified: boolean;
  reject_reason: string | null;
}

export interface EtlEdit {
  by: string;
  at: string;
  against?: string;
  reviewed: boolean;
}

export interface EtlSwingDoc {
  schema: 'tennis.swing/1';
  id: string;
  source: Record<string, unknown>;
  trim: EtlTrim;
  crop: Record<string, unknown>;
  detection: EtlDetection;
  labels: EtlLabels;
  frames: EtlFrame[];
  measurements: Record<string, unknown> | null;
  edit: EtlEdit | null;
}

export interface EtlSwingRef {
  id: string;
  dir: string;
  contact_ms: number;
  duration_ms: number;
  player_slot: EtlPlayerSlot;
  frame_count: number;
  verified: boolean;
  reviewed: boolean;
}

export interface EtlSessionDoc {
  schema: 'tennis.session/1';
  source: { name: string; [k: string]: unknown };
  settings: Record<string, unknown>;
  detection: Record<string, unknown>;
  players: Record<string, unknown>;
  swings: EtlSwingRef[];
}

/** One swing as `/api/session` returns it: the doc, where it lives, and its hash. */
export interface SwingEntry {
  dir: string;
  /** `doc_hash` of the ETL-owned content, for `edit.against`. */
  hash: string;
  doc: EtlSwingDoc;
}

/** The whole `/api/session` response. */
export interface SessionPayload {
  session: string;
  swings: SwingEntry[];
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (nothing imports the new file yet).

- [ ] **Step 4: Commit**

```bash
git add src/domain/etl-types.ts src/domain/__fixtures__/swing-real.json
git commit -m "Add TypeScript mirror of the ETL JSON shapes, plus a real fixture"
```

---

## Task 2: App types absorb the ETL vocabulary

Widens `Clip`/`Frame` and fixes every call site the widening breaks. No adapter yet — this task is purely "the app can represent ETL data".

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/grades.ts:17-25`
- Modify: `src/lib/selectors.ts:49`, `:118`
- Modify: `src/components/shared.tsx:229`, `:241`
- Modify: `src/components/DetailView.tsx:51`, `:227`
- Modify: `src/domain/seed.ts` (add `sourceMs` to seeded frames)
- Test: `src/lib/selectors.test.ts` (existing suite must stay green)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Frame.sourceMs: number`, `Frame.conf?: number`, `Clip.stroke: Stroke | null`, `STROKES` including `Overhead`/`Other` and excluding `Slice`, `UNTAGGED_STROKE`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/selectors.test.ts`:

```ts
describe('null strokes', () => {
  it('an untagged clip survives the "all strokes" filter but no specific one', () => {
    const d = doc();
    d.clips = [{ ...d.clips[0], id: 'X-1', stroke: null }];
    expect(visibleClips(d, ui()).map((c) => c.id)).toEqual(['X-1']);
    expect(visibleClips(d, ui({ strokeFilter: 'Forehand' }))).toHaveLength(0);
  });

  it('strokesOf never offers null as a filter option', () => {
    const d = doc();
    d.clips = [{ ...d.clips[0], stroke: null }, { ...d.clips[1], stroke: 'Backhand' }];
    expect(strokesOf(d)).toEqual(['Backhand']);
  });
});
```

Add `strokesOf` to the existing import from `./selectors`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/selectors.test.ts`
Expected: FAIL — TypeScript rejects `stroke: null` (type `Stroke`), and `strokesOf` returns the null.

- [ ] **Step 3: Widen the types**

In `src/domain/types.ts` replace the `STROKES` line and the `Frame`/`Clip` members:

```ts
/**
 * Mirrors `STROKES` in `tennisproc/schema.py`, which owns the vocabulary.
 * `Slice` is deliberately absent: the ETL cannot emit it (spin is not
 * recoverable at 30 fps), so nothing could ever produce the value.
 */
export const STROKES = [
  'Forehand',
  'Backhand',
  'Serve',
  'Volley',
  'Overhead',
  'Other',
] as const;
export type Stroke = (typeof STROKES)[number];

/** Shown where a stroke would go on a clip the ETL left unlabelled. */
export const UNTAGGED_STROKE = 'untagged';
```

In `interface Frame`, replace the `conf` line with:

```ts
  /** Milliseconds into the source video. The join key for `user-edit.json`;
   *  `i` is only a render index and shifts when sampling changes. */
  sourceMs: number;
  phase: Phase | null;
  /**
   * Classifier confidence, 0–1. Below CONFIDENCE_FLOOR the frame is flagged.
   * Absent on ETL clips: there is no classifier, and `pose_score` measures
   * landmark quality, which is a different quantity.
   */
  conf?: number;
```

In `interface Clip`, change `stroke`:

```ts
  /** Null until a human labels it — the ETL ships every stroke unlabelled. */
  stroke: Stroke | null;
```

- [ ] **Step 4: Fix the call sites**

`src/domain/grades.ts` — accept null and cover the new strokes:

```ts
const STROKE_HUES: Record<string, Hue> = {
  Forehand: 'green',
  Backhand: 'blue',
  Serve: 'violet',
  Volley: 'pink',
  Overhead: 'orange',
  Other: 'gray',
};

export const strokeHue = (stroke: string | null): Hue =>
  stroke === null ? 'gray' : STROKE_HUES[stroke] ?? 'gray';
```

`src/lib/selectors.ts:118` — drop nulls from the options:

```ts
export const strokesOf = (doc: Doc): string[] =>
  Array.from(new Set(doc.clips.map((c) => c.stroke).filter((s): s is Stroke => s !== null)));
```

Add `import type { Clip, Comment, Phase, Stroke } from '@/domain/types';` (extend the existing type import).

`selectors.ts:49` needs no change: `c.stroke === ui.strokeFilter` is already false for `null` against any real stroke, and the `ALL_STROKES` branch short-circuits.

`src/components/shared.tsx` — render the untagged state (line ~229 and ~241):

```tsx
          value={clip.stroke ?? ''}
```
```tsx
      <Tag size="sm" interactive hue={strokeHue(clip.stroke)} emphasis="soft" hint-size="auto,20px">
        {clip.stroke ?? UNTAGGED_STROKE}
      </Tag>
```

Apply the identical two changes in `src/components/DetailView.tsx` (`value={clip.stroke ?? ''}` at ~227, and `{clip.stroke ?? UNTAGGED_STROKE}` at ~51). Import `UNTAGGED_STROKE` from `@/domain/types` in both files.

`src/components/CompareView.tsx:266-273` builds a synthetic cell; add `sourceMs: frame?.sourceMs ?? 0` if the object literal is typed as a `Frame`. If it is typed as a `Cell`, leave it alone.

- [ ] **Step 5: Give seeded frames a sourceMs**

In `src/domain/seed.ts`, inside `buildFrames`, add to the returned object:

```ts
    // The seed has no source video; 33 ms apart mimics 30 fps so ordering and
    // any join logic behave the same as on real output.
    sourceMs: i * 33,
```

- [ ] **Step 6: Run the full frontend suite**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: typecheck clean, 24 tests pass (22 existing + 2 new), lint clean.

If `CatalogView.tsx` or `Inspector.tsx` fail to typecheck on `clip.stroke`, apply the same `?? UNTAGGED_STROKE` treatment at the reported line.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/domain/grades.ts src/domain/seed.ts src/lib/selectors.ts src/lib/selectors.test.ts src/components
git commit -m "Widen Clip/Frame to represent ETL output: nullable stroke, sourceMs, optional conf"
```

---

## Task 3: Read adapter and frame sampling

**Files:**
- Create: `src/domain/etl.ts`
- Create: `src/domain/etl.test.ts`

**Interfaces:**
- Consumes: `EtlSwingDoc`, `EtlFrame`, `SwingEntry` (Task 1); `Clip`, `Frame`, `Stroke`, `Phase`, `Grade`, `FRAMES_PER_CLIP` (Task 2).
- Produces:
  - `sampleFrames(frames: EtlFrame[], contactMs: number, stepMs?: number): EtlFrame[]`
  - `adaptSwing(doc: EtlSwingDoc): Clip`
  - `adaptSession(payload: SessionPayload): Clip[]`
  - `strokeToApp(s: EtlStroke | null): Stroke | null`
  - `qualityToGrade(q: number | null): Grade | null`
  - `stageToPhase(s: EtlStage | null): Phase | null`
  - `mediaUrlFor(session: string, dir: string, file: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/etl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import realSwing from './__fixtures__/swing-real.json';
import type { EtlSwingDoc } from './etl-types';
import { adaptSwing, qualityToGrade, sampleFrames, stageToPhase, strokeToApp } from './etl';
import { FRAMES_PER_CLIP } from './types';

const fixture = realSwing as unknown as EtlSwingDoc;

describe('sampleFrames', () => {
  it('takes a 9-frame window centred on contact from a real 49-frame swing', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    expect(picked).toHaveLength(FRAMES_PER_CLIP);
    // Verified against the real fixture: contact_ms 6301, 33 ms frame step.
    expect(picked.map((f) => f.offset_contact_ms)).toEqual([
      -133, -100, -67, -33, 0, 33, 67, 100, 133,
    ]);
    expect(picked.map((f) => f.source_ms)).toEqual([
      6168, 6201, 6234, 6268, 6301, 6334, 6368, 6401, 6434,
    ]);
  });

  it('always includes the contact frame', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    expect(picked.filter((f) => f.offset_contact_ms === 0)).toHaveLength(1);
  });

  it('de-duplicates rather than repeating a frame when the swing is sparse', () => {
    const sparse = [
      { ...fixture.frames[0], source_ms: 1000, offset_contact_ms: -200 },
      { ...fixture.frames[1], source_ms: 1200, offset_contact_ms: 0 },
      { ...fixture.frames[2], source_ms: 1400, offset_contact_ms: 200 },
    ];
    const picked = sampleFrames(sparse, 1200);
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(new Set(picked.map((f) => f.source_ms)).size).toBe(picked.length);
  });

  it('returns frames in ascending source_ms', () => {
    const picked = sampleFrames(fixture.frames, fixture.detection.contact_ms);
    const ms = picked.map((f) => f.source_ms);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });
});

describe('enum mapping', () => {
  it('capitalises every ETL stroke and keeps null null', () => {
    expect(strokeToApp('forehand')).toBe('Forehand');
    expect(strokeToApp('overhead')).toBe('Overhead');
    expect(strokeToApp('other')).toBe('Other');
    expect(strokeToApp(null)).toBeNull();
  });

  it('maps stage other to no phase', () => {
    expect(stageToPhase('contact')).toBe('contact');
    expect(stageToPhase('other')).toBeNull();
    expect(stageToPhase(null)).toBeNull();
  });

  it('folds 1-5 quality onto the three grades', () => {
    expect(qualityToGrade(1)).toBe('work');
    expect(qualityToGrade(2)).toBe('work');
    expect(qualityToGrade(3)).toBe('ok');
    expect(qualityToGrade(4)).toBe('good');
    expect(qualityToGrade(5)).toBe('good');
    expect(qualityToGrade(null)).toBeNull();
  });
});

describe('adaptSwing', () => {
  it('carries the real id, slot name and frame identity through', () => {
    const clip = adaptSwing(fixture);
    expect(clip.id).toBe('IMG_0304/swing_001');
    // player_name is null in ETL output, so the court zone stands in.
    expect(clip.player).toBe('left');
    expect(clip.stroke).toBeNull();
    expect(clip.frames).toHaveLength(FRAMES_PER_CLIP);
    expect(clip.frames.map((f) => f.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(clip.frames[4].sourceMs).toBe(6301);
  });

  it('reports a verified, unreviewed swing as neither rejected nor triaged', () => {
    const clip = adaptSwing(fixture);
    expect(clip.rejected).toBe(false);
    expect(clip.triaged).toBe(false);
    expect(clip.grade).toBeNull();
    expect(clip.note).toBe('');
  });

  it('formats duration from the trim span', () => {
    // 8301 - 4801 = 3500 ms
    expect(adaptSwing(fixture).duration).toBe('0:03');
  });

  it('rejects a swing the detector failed or a human called a false positive', () => {
    const unverified: EtlSwingDoc = {
      ...fixture,
      detection: { ...fixture.detection, verified: false },
    };
    expect(adaptSwing(unverified).rejected).toBe(true);

    const dupe: EtlSwingDoc = {
      ...fixture,
      labels: { ...fixture.labels, verdict: 'duplicate' },
    };
    expect(adaptSwing(dupe).rejected).toBe(true);
  });

  it('treats an existing edit as triaged', () => {
    const edited: EtlSwingDoc = {
      ...fixture,
      edit: { by: 'wc', at: '2026-08-16T10:12:04Z', reviewed: true },
    };
    expect(adaptSwing(edited).triaged).toBe(true);
  });

  it('leaves conf unset, because the ETL has no classifier', () => {
    for (const f of adaptSwing(fixture).frames) {
      expect(f.conf).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/etl.test.ts`
Expected: FAIL — `Cannot find module './etl'`.

- [ ] **Step 3: Write the adapter**

Create `src/domain/etl.ts`:

```ts
import type {
  EtlFrame,
  EtlStage,
  EtlStroke,
  EtlSwingDoc,
  SessionPayload,
} from './etl-types';
import type { Clip, Frame, Grade, Phase, Stroke } from './types';
import { FRAMES_PER_CLIP } from './types';

/** Offsets, in frames, that the compare grid samples around contact. */
const WINDOW = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

/** Source frame interval at 30 fps. Real output steps 33 ms. */
const DEFAULT_STEP_MS = 33;

/**
 * Narrows a swing's 42-49 stills to the compare grid's width, centred on
 * contact so `buildCompare` can align every row on the same column.
 *
 * Contact is selected first and never dropped: the other targets are resolved
 * around it, and duplicates are removed by `source_ms`, so a sparse swing
 * yields fewer than nine frames rather than the same frame twice.
 */
export function sampleFrames(
  frames: EtlFrame[],
  contactMs: number,
  stepMs: number = DEFAULT_STEP_MS,
): EtlFrame[] {
  if (frames.length === 0) return [];

  const nearest = (targetMs: number): EtlFrame =>
    frames.reduce((best, f) =>
      Math.abs(f.source_ms - targetMs) < Math.abs(best.source_ms - targetMs) ? f : best,
    );

  const picked = new Map<number, EtlFrame>();
  const contact = nearest(contactMs);
  picked.set(contact.source_ms, contact);

  for (const k of WINDOW) {
    if (k === 0) continue;
    const f = nearest(contactMs + k * stepMs);
    if (!picked.has(f.source_ms)) picked.set(f.source_ms, f);
  }

  return [...picked.values()].sort((a, b) => a.source_ms - b.source_ms);
}

export const strokeToApp = (s: EtlStroke | null): Stroke | null =>
  s === null ? null : ((s.charAt(0).toUpperCase() + s.slice(1)) as Stroke);

/**
 * `other` means "tagged, but not a phase boundary", which for alignment is
 * indistinguishable from untagged — the compare view can only anchor on the
 * three real phases.
 */
export const stageToPhase = (s: EtlStage | null): Phase | null =>
  s === null || s === 'other' ? null : s;

/**
 * ETL quality is 1-5, the app's grade has three values, so this is lossy by
 * construction. Documented in the spec: a quality of 1 round-trips back as 2.
 */
export const qualityToGrade = (q: number | null): Grade | null => {
  if (q === null) return null;
  if (q <= 2) return 'work';
  if (q === 3) return 'ok';
  return 'good';
};

const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** `<session>/<dir>/<file>` under the dev middleware's media route. */
export const mediaUrlFor = (session: string, dir: string, file: string): string =>
  `/api/media/${session}/${dir}/${file}`;

/**
 * One `SwingDoc` as the review UI sees it.
 *
 * `player_slot` stands in for a name because a slot is all the pipeline can
 * honestly know; `stroke` stays null because classification is not part of the
 * ETL. Neither is a placeholder to be filled with a guess.
 */
export function adaptSwing(doc: EtlSwingDoc, mediaBase?: string): Clip {
  const sampled = sampleFrames(doc.frames, doc.detection.contact_ms);

  const frames: Frame[] = sampled.map((f, i) => ({
    i,
    sourceMs: f.source_ms,
    phase: stageToPhase(f.stage),
    ...(mediaBase === undefined ? {} : { imageUrl: `${mediaBase}/${f.file}` }),
  }));

  const rejected =
    !doc.detection.verified ||
    doc.labels.verdict === 'false_positive' ||
    doc.labels.verdict === 'duplicate';

  return {
    id: doc.id,
    player: doc.labels.player_name ?? doc.labels.player_slot,
    stroke: strokeToApp(doc.labels.stroke),
    rejected,
    duration: formatDuration(doc.trim.source_end_ms - doc.trim.source_start_ms),
    triaged: doc.edit?.reviewed === true,
    grade: qualityToGrade(doc.labels.quality),
    note: doc.labels.notes ?? '',
    frames,
  };
}

export const adaptSession = (payload: SessionPayload): Clip[] =>
  payload.swings.map((entry) =>
    adaptSwing(entry.doc, `/api/media/${payload.session}/${entry.dir}`),
  );
```

Note: `Clip` has no `conf` in the ETL path. If `Clip.conf` is still required by the interface, make it optional in `types.ts` the same way `Frame.conf` was, and drop it here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/etl.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Full suite and lint**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: all green.

`resolveJsonModule` may be needed for the fixture import. If typecheck complains, add `"resolveJsonModule": true` to `compilerOptions` in `tsconfig.json`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/etl.ts src/domain/etl.test.ts tsconfig.json
git commit -m "Add the ETL read adapter: sample 9 frames around contact, map enums"
```

---

## Task 4: Untagged-stroke affordance in the UI

Task 2 made `null` renderable; this task makes it *legible* — an untagged clip should read as work to do, not as a blank.

**Files:**
- Modify: `src/components/shared.tsx` (the stroke `Tag`)
- Test: `src/components/stroke-tag.test.tsx` (create)

**Interfaces:**
- Consumes: `UNTAGGED_STROKE` (Task 2), `adaptSwing` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `src/components/stroke-tag.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import type { EtlSwingDoc } from '@/domain/etl-types';
import { adaptSwing } from '@/domain/etl';
import { DetailView } from './DetailView';

const clip = adaptSwing(realSwing as unknown as EtlSwingDoc);

describe('a clip the ETL left unlabelled', () => {
  it('says untagged where a stroke would go', () => {
    render(
      <DetailView
        clip={clip}
        selectedFrame={0}
        comments={[]}
        roster={['left']}
        playing={false}
        dispatch={() => {}}
      />,
    );
    expect(screen.getByText('untagged')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/stroke-tag.test.tsx`
Expected: FAIL — nothing renders the text `untagged` yet (Task 2 wired `?? UNTAGGED_STROKE`; if that already satisfies it, this test passes immediately and confirms Task 2 — record that and move to Step 4).

- [ ] **Step 3: Make the untagged state visible**

In `src/components/shared.tsx`, in the stroke `Tag` branch, dim the tag when there is no stroke so it reads as pending rather than as a value:

```tsx
      <Tag
        size="sm"
        interactive
        hue={strokeHue(clip.stroke)}
        emphasis="soft"
        hint-size="auto,20px"
        style={clip.stroke === null ? { opacity: 0.62 } : undefined}
      >
        {clip.stroke ?? UNTAGGED_STROKE}
      </Tag>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/stroke-tag.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/shared.tsx src/components/stroke-tag.test.tsx
git commit -m "Render an unlabelled stroke as a dimmed untagged tag"
```

---

## Task 5: Dev middleware read path and app hydration

**Files:**
- Create: `vite-plugin-shot-lab.ts`
- Create: `src/state/etl-source.ts`
- Create: `src/state/etl-source.test.ts`
- Modify: `vite.config.ts`
- Modify: `src/state/store.ts`

**Interfaces:**
- Consumes: `SessionPayload`, `EtlSwingDoc` (Task 1); `adaptSession` (Task 3).
- Produces:
  - `shotLab(): Plugin` — default export of `vite-plugin-shot-lab.ts`
  - `loadEtlClips(): Promise<Clip[] | null>` — `null` means "no tree, keep the seed"
  - store action `{ type: 'hydrate'; clips: Clip[] }`

- [ ] **Step 1: Write the failing test**

Create `src/state/etl-source.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import realSwing from '@/domain/__fixtures__/swing-real.json';
import { loadEtlClips } from './etl-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

const payload = {
  session: 'IMG_0304',
  swings: [{ dir: 'swings/swing_001', hash: 'sha256:abc', doc: realSwing }],
};

describe('loadEtlClips', () => {
  it('adapts a session payload into clips', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }),
    );
    const clips = await loadEtlClips();
    expect(clips).not.toBeNull();
    expect(clips).toHaveLength(1);
    expect(clips?.[0].id).toBe('IMG_0304/swing_001');
  });

  it('returns null when there is no out/ tree, so the seed stands', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await loadEtlClips()).toBeNull();
  });

  it('returns null rather than throwing when the dev server is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await loadEtlClips()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/etl-source.test.ts`
Expected: FAIL — `Cannot find module './etl-source'`.

- [ ] **Step 3: Write the fetch wrapper**

Create `src/state/etl-source.ts`:

```ts
import type { Clip } from '@/domain/types';
import type { SessionPayload } from '@/domain/etl-types';
import { adaptSession } from '@/domain/etl';

/**
 * Reads the ETL session the dev middleware serves.
 *
 * Returns `null` for every "there is nothing to load" case — no `out/` tree, no
 * dev server, a static build, a malformed response. The caller keeps the seed,
 * so a missing tree is a normal state rather than an error the user has to see.
 */
export async function loadEtlClips(): Promise<Clip[] | null> {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return null;
    const payload = (await res.json()) as SessionPayload;
    if (!Array.isArray(payload.swings) || payload.swings.length === 0) return null;
    return adaptSession(payload);
  } catch {
    // No dev server (static preview, or `vite build` output). Seed stands.
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/etl-source.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the middleware**

Create `vite-plugin-shot-lab.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Serves the `tennisproc` output tree to the review app in dev.
 *
 * Dev only, by design: the app must keep working without it (see
 * `loadEtlClips`), so `vite build` output never depends on this route.
 */

const OUT_ROOT = () => resolve(process.env.SHOT_LAB_OUT ?? 'out');

/** The one filename the app is allowed to write. */
const WRITABLE = 'user-edit.json';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
};

/**
 * Resolves a request path inside the output root, or returns null.
 *
 * Rejecting on the resolved prefix is what stops `../` in a URL from reaching
 * outside `out/` — checking the raw string would miss encoded traversals.
 */
function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  return full === root || full.startsWith(root + sep) ? full : null;
}

/** Mirrors `schema.doc_hash`: sorted-key JSON of everything but `edit`. */
function docHash(doc: Record<string, unknown>): string {
  const { edit: _edit, ...rest } = doc;
  const blob = JSON.stringify(sortKeys(rest));
  return 'sha256:' + createHash('sha256').update(blob).digest('hex').slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** First directory under `out/` that has a `swings/` child. */
function findSession(root: string): string | null {
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort()) {
    if (existsSync(join(root, name, 'swings'))) return name;
  }
  return null;
}

function readSession(root: string) {
  const session = findSession(root);
  if (session === null) return null;

  const swingsDir = join(root, session, 'swings');
  const swings = readdirSync(swingsDir)
    .filter((d) => d.startsWith('swing_'))
    .sort()
    .flatMap((dir) => {
      const metaPath = join(swingsDir, dir, 'metadata.json');
      if (!existsSync(metaPath)) return [];
      const doc = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
      return [{ dir: `swings/${dir}`, hash: docHash(doc), doc }];
    });

  return { session, swings };
}

export default function shotLab(): Plugin {
  return {
    name: 'shot-lab-etl',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/session', (_req, res) => {
        const payload = readSession(OUT_ROOT());
        if (payload === null) {
          res.statusCode = 404;
          res.end('{"error":"no session"}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      });

      server.middlewares.use('/api/media', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const full = safeJoin(OUT_ROOT(), rel);
        if (full === null || !existsSync(full) || !statSync(full).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', MIME[extname(full).toLowerCase()] ?? 'application/octet-stream');
        res.end(readFileSync(full));
      });
    },
  };
}

export { docHash, safeJoin, WRITABLE };
```

- [ ] **Step 5b: Prove docHash matches the Python implementation**

`edit.against` is only meaningful if the middleware's hash equals
`schema.doc_hash`. Both were checked against the real fixture during planning and
agree, but a regression here would be silent — it would produce plausible hashes
that never match. Pin it:

```bash
cd /Users/wc/code/github/wwchen/tennis2
.venv313/bin/python -c "
import json
from tennisproc import schema
print(schema.doc_hash(json.load(open('src/domain/__fixtures__/swing-real.json'))))"
```
Expected: `sha256:6caa72ffd3c91439`

Then add to `tests/test_app_writeback.py` in Task 7 (or now, if convenient):

```python
    def test_doc_hash_of_the_fixture_is_pinned(self):
        """The vite middleware reimplements this in TypeScript; if either side
        changes its JSON canonicalisation, edit.against silently stops
        matching. Pinning the value makes that a test failure."""
        self.assertEqual(schema.doc_hash(self.metadata),
                         "sha256:6caa72ffd3c91439")
```

Python's `json.dumps(sort_keys=True, separators=(",", ":"))` and
`JSON.stringify` over recursively key-sorted objects agree because the document
holds only strings, finite numbers, booleans, nulls, arrays and objects. Do not
add float formatting or non-ASCII keys to the hashed payload without re-checking.

- [ ] **Step 6: Register the plugin**

In `vite.config.ts`, add the import and list it in `plugins`:

```ts
import shotLab from './vite-plugin-shot-lab';
```
```ts
  plugins: [react(), shotLab()],
```

- [ ] **Step 7: Add the hydrate action**

In `src/state/store.ts`, add to the `Action` union:

```ts
  | { type: 'hydrate'; clips: Clip[] }
```

Add `import type { Clip } from '@/domain/types';` to the existing type imports.

Add the case to the reducer, before `case 'select'`:

```ts
    case 'hydrate':
      // Replaces the seed wholesale. Comments are seeded scratch data pinned to
      // seed clip ids, so they go too rather than dangle on ids that no longer
      // exist.
      return {
        ...state,
        doc: { ...doc, clips: action.clips, comments: [], removedStack: [] },
        ui: { ...state.ui, sel: null, detail: null },
      };
```

In `useShotLab`, hydrate once on mount:

```ts
  useEffect(() => {
    let live = true;
    void loadEtlClips().then((clips) => {
      if (live && clips !== null) dispatch({ type: 'hydrate', clips });
    });
    return () => {
      live = false;
    };
  }, []);
```

Add `import { loadEtlClips } from './etl-source';`.

- [ ] **Step 8: Verify the middleware against the real tree**

```bash
SHOT_LAB_OUT=/Users/wc/.claude/jobs/cff85809/tmp/out npm run dev &
sleep 8
curl -s localhost:5173/api/session | head -c 300
curl -s -o /dev/null -w "media: %{http_code}\n" \
  "localhost:5173/api/media/IMG_0304/swings/swing_001/frames/frame_0024.jpg"
curl -s -o /dev/null -w "traversal: %{http_code}\n" \
  "localhost:5173/api/media/../../../etc/passwd"
kill %1
```
Expected: session JSON with 42 swings; `media: 200`; `traversal: 404`.

If the port is taken, vite picks another — read the printed port and use it.

- [ ] **Step 9: Full suite**

Run: `npm run typecheck && npx vitest run && npm run lint && npm run build`
Expected: all green. `build` proves the app still compiles without the middleware.

- [ ] **Step 10: Commit**

```bash
git add vite-plugin-shot-lab.ts vite.config.ts src/state/etl-source.ts src/state/etl-source.test.ts src/state/store.ts
git commit -m "Serve the ETL out/ tree in dev and hydrate the app from it"
```

---

## Task 6: Real thumbnails in FrameTile

**Files:**
- Modify: `src/domain/types.ts` (`Frame.imageUrl`)
- Modify: `src/lib/selectors.ts` (carry `imageUrl` onto the cell)
- Modify: `src/components/shared.tsx` (`FrameTile` renders the image)
- Test: `src/components/frame-tile.test.tsx` (create)

**Interfaces:**
- Consumes: `adaptSwing` with a media base (Task 3), `Cell` (existing).
- Produces: `Frame.imageUrl?: string`, `Cell.imageUrl?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/components/frame-tile.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FrameTile } from './shared';

const cell = {
  real: true as const,
  key: 'k',
  clip: 'IMG_0304/swing_001',
  frame: 0,
  num: 'f01',
  phase: null,
  flagged: false,
  pinCount: 0,
  selected: false,
};

describe('FrameTile', () => {
  it('renders the frame image when one is available', () => {
    render(
      <FrameTile
        cell={{ ...cell, imageUrl: '/api/media/IMG_0304/swings/swing_001/frames/frame_0020.jpg' }}
        onClick={() => {}}
      />,
    );
    const img = screen.getByRole('presentation');
    expect(img).toHaveAttribute(
      'src',
      '/api/media/IMG_0304/swings/swing_001/frames/frame_0020.jpg',
    );
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('renders no image for a seeded clip, leaving the painted tile alone', () => {
    render(<FrameTile cell={cell} onClick={() => {}} />);
    expect(screen.queryByRole('presentation')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/frame-tile.test.tsx`
Expected: FAIL — no image element is rendered.

- [ ] **Step 3: Thread imageUrl through the types**

In `src/domain/types.ts`, add to `interface Frame`:

```ts
  /** Served by the dev middleware. Absent for seeded clips. */
  imageUrl?: string;
```

In `src/lib/selectors.ts`, add to the `Cell` real variant:

```ts
      imageUrl?: string;
```

and in `buildCompare`'s cell construction, after `phase: f.phase,`:

```ts
        imageUrl: f.imageUrl,
```

- [ ] **Step 4: Render the image**

In `src/components/shared.tsx`, inside `FrameTile`, immediately after the opening `<button ...>` tag and before the `PhaseBadge` line:

```tsx
      {cell.imageUrl !== undefined && (
        <img
          src={cell.imageUrl}
          alt=""
          role="presentation"
          loading="lazy"
          decoding="async"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
        />
      )}
```

The painted gradient in `.frame-still` stays as the backdrop, so a still that has
not loaded yet looks like today's tile rather than an empty box.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/frame-tile.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Full suite**

Run: `npm run typecheck && npx vitest run && npm run lint`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/lib/selectors.ts src/components/shared.tsx src/components/frame-tile.test.tsx
git commit -m "Render real ETL frame stills in the compare grid"
```

Note for the reviewer: these stills come from stub-pose crops and will be badly
framed (mostly ceiling). That is an ETL data limitation recorded in the spec, not
a bug in this task.

---

## Task 7: Write-back to user-edit.json

**Files:**
- Create: `src/domain/etl-write.ts`
- Create: `src/domain/etl-write.test.ts`
- Create: `tests/test_app_writeback.py`
- Modify: `vite-plugin-shot-lab.ts` (PUT route)
- Modify: `src/state/store.ts` (persist edits)

**Interfaces:**
- Consumes: `EtlSwingDoc`, `SwingEntry` (Task 1); `Clip` (Task 2); `adaptSwing` (Task 3).
- Produces:
  - `toUserEdit(clip: Clip, source: EtlSwingDoc, hash: string, by: string, at: string): EtlSwingDoc`
  - `PUT /api/swings/:session/:dir/user-edit`

- [ ] **Step 1: Write the failing test**

Create `src/domain/etl-write.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import realSwing from './__fixtures__/swing-real.json';
import type { EtlSwingDoc } from './etl-types';
import { adaptSwing } from './etl';
import { toUserEdit } from './etl-write';

const source = realSwing as unknown as EtlSwingDoc;
const AT = '2026-08-16T12:00:00Z';

describe('toUserEdit', () => {
  it('writes the human labels a reviewer set', () => {
    const clip = { ...adaptSwing(source), stroke: 'Backhand' as const, grade: 'good' as const, note: 'late' };
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.stroke).toBe('backhand');
    expect(doc.labels.quality).toBe(4);
    expect(doc.labels.notes).toBe('late');
    expect(doc.edit).toEqual({ by: 'wc', at: AT, against: 'sha256:abc', reviewed: true });
  });

  it('echoes ETL-owned blocks unchanged so the file is a standalone SwingDoc', () => {
    const doc = toUserEdit(adaptSwing(source), source, 'sha256:abc', 'wc', AT);
    expect(doc.schema).toBe('tennis.swing/1');
    expect(doc.id).toBe(source.id);
    expect(doc.trim).toEqual(source.trim);
    expect(doc.detection).toEqual(source.detection);
    expect(doc.measurements).toEqual(source.measurements);
  });

  it('keys frames on source_ms and writes only the sampled ones', () => {
    const clip = adaptSwing(source);
    clip.frames[4] = { ...clip.frames[4], phase: 'contact' };
    const doc = toUserEdit(clip, source, 'sha256:abc', 'wc', AT);
    expect(doc.frames).toHaveLength(9);
    expect(doc.frames.map((f) => f.source_ms)).toEqual([
      6168, 6201, 6234, 6268, 6301, 6334, 6368, 6401, 6434,
    ]);
    const contact = doc.frames.find((f) => f.source_ms === 6301);
    expect(contact?.stage).toBe('contact');
  });

  it('records a rejected clip as a verdict, not by editing detection', () => {
    const doc = toUserEdit({ ...adaptSwing(source), rejected: true }, source, 'sha256:abc', 'wc', AT);
    expect(doc.labels.verdict).toBe('false_positive');
    expect(doc.detection.verified).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/etl-write.test.ts`
Expected: FAIL — `Cannot find module './etl-write'`.

- [ ] **Step 3: Write the write adapter**

Create `src/domain/etl-write.ts`:

```ts
import type { EtlFrame, EtlStroke, EtlSwingDoc } from './etl-types';
import type { Clip, Grade } from './types';

/**
 * Builds the `user-edit.json` document for one clip.
 *
 * The whole `SwingDoc` is written, not a patch: `user-edit.json` is the same
 * schema as `metadata.json` and one validator serves both. ETL-owned blocks are
 * echoed from `source` so the file stands alone; `overlay()` ignores them from
 * the edit side regardless.
 */
export function toUserEdit(
  clip: Clip,
  source: EtlSwingDoc,
  hash: string,
  by: string,
  at: string,
): EtlSwingDoc {
  const stageBySourceMs = new Map(clip.frames.map((f) => [f.sourceMs, f.phase]));

  // Only the sampled frames are written, so the 40 frames the compare grid never
  // showed keep whatever stage they already had.
  const frames: EtlFrame[] = source.frames
    .filter((f) => stageBySourceMs.has(f.source_ms))
    .map((f) => ({ ...f, stage: stageBySourceMs.get(f.source_ms) ?? null }));

  return {
    ...source,
    labels: {
      ...source.labels,
      player_name: clip.player,
      stroke: strokeToEtl(clip.stroke),
      quality: gradeToQuality(clip.grade),
      // A human calling a clip bad is a verdict; `detection` stays the ETL's.
      verdict: clip.rejected ? 'false_positive' : 'valid',
      notes: clip.note === '' ? null : clip.note,
    },
    frames,
    edit: { by, at, against: hash, reviewed: true },
  };
}

const strokeToEtl = (s: Clip['stroke']): EtlStroke | null =>
  s === null ? null : (s.toLowerCase() as EtlStroke);

/** Inverse of `qualityToGrade`, and lossy the same way: `work` writes 2. */
const gradeToQuality = (g: Grade | null): 2 | 3 | 4 | null => {
  if (g === null) return null;
  if (g === 'work') return 2;
  if (g === 'ok') return 3;
  return 4;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/etl-write.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the PUT route**

In `vite-plugin-shot-lab.ts`, inside `configureServer`, add:

```ts
      server.middlewares.use('/api/swings', (req, res) => {
        if (req.method !== 'PUT') {
          res.statusCode = 405;
          res.end();
          return;
        }
        // `/<session>/<swings/swing_NNN>/user-edit`
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const suffix = '/user-edit';
        if (!rel.endsWith(suffix)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const dir = safeJoin(OUT_ROOT(), rel.slice(0, -suffix.length));
        if (dir === null || !existsSync(dir)) {
          res.statusCode = 404;
          res.end();
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const doc = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
            // The one writable filename. Everything else in the tree is the
            // ETL's, so a bug here cannot reach metadata.json.
            writeFileSync(join(dir, WRITABLE), JSON.stringify(doc, null, 1) + '\n');
            res.statusCode = 204;
            res.end();
          } catch {
            res.statusCode = 400;
            res.end('{"error":"bad document"}');
          }
        });
      });
```

Extend the `node:fs` import with `writeFileSync`.

- [ ] **Step 6: Persist edits from the store**

In `src/state/store.ts`, keep the ETL source docs alongside the clips so
write-back has `source` and `hash`. Extend the hydrate action:

```ts
  | { type: 'hydrate'; clips: Clip[]; entries: SwingEntry[]; session: string }
```

Store `entries`/`session` on `State` (not `Doc` — they are not coaching data and
must not go to localStorage). In `useShotLab`, add a debounced effect:

```ts
  useEffect(() => {
    if (state.session === null) return;
    const timer = setTimeout(() => {
      for (const entry of state.entries) {
        const clip = state.doc.clips.find((c) => c.id === entry.doc.id);
        if (clip === undefined || !clip.triaged) continue;
        void fetch(`/api/swings/${state.session}/${entry.dir}/user-edit`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            toUserEdit(clip, entry.doc, entry.hash, 'reviewer', new Date().toISOString()),
          ),
        }).catch(() => {
          // Dev-only route; a static build has nowhere to write.
        });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [state.doc.clips, state.entries, state.session]);
```

Have `loadEtlClips` return `{ clips, entries, session }` instead of `Clip[]`, and
update `src/state/etl-source.test.ts` to match the new shape.

- [ ] **Step 7: Write the Python round-trip test**

Create `tests/test_app_writeback.py`:

```python
"""The app writes user-edit.json; this checks the ETL can read it back.

Deliberately validated by schema.py rather than by a TypeScript assertion: a
TS mirror of the validator could drift from the real one, and drift between a
validator and its pipeline is exactly the bug class this suite exists to catch.
"""

import json
import os
import shutil
import tempfile
import unittest

from tennisproc import schema, session

FIXTURE = os.path.join(os.path.dirname(__file__), os.pardir,
                       "src", "domain", "__fixtures__", "swing-real.json")


class TestAppWriteback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        with open(FIXTURE, encoding="utf-8") as fh:
            self.metadata = json.load(fh)

    def _user_edit(self, **labels):
        """The document shape src/domain/etl-write.ts produces."""
        doc = dict(self.metadata)
        doc["labels"] = dict(self.metadata["labels"], **labels)
        doc["edit"] = {"by": "reviewer", "at": "2026-08-16T12:00:00Z",
                       "against": schema.doc_hash(self.metadata),
                       "reviewed": True}
        return doc

    def test_app_written_document_is_valid(self):
        doc = self._user_edit(stroke="backhand", quality=4, verdict="valid",
                              notes="late contact")
        self.assertEqual(schema.validate_swing(doc), [])

    def test_overlay_surfaces_the_humans_labels(self):
        edit = self._user_edit(stroke="backhand", quality=4, verdict="valid")
        merged = schema.overlay(self.metadata, edit)
        self.assertEqual(merged["labels"]["stroke"], "backhand")
        self.assertEqual(merged["labels"]["quality"], 4)
        # ETL-owned facts survive a stale or hostile edit.
        self.assertEqual(merged["detection"], self.metadata["detection"])
        self.assertEqual(merged["trim"], self.metadata["trim"])

    def test_stage_lands_on_the_same_moment_by_source_ms(self):
        contact_ms = self.metadata["detection"]["contact_ms"]
        edit = self._user_edit()
        edit["frames"] = [{"file": "frames/frame_0024.jpg",
                           "source_ms": contact_ms, "clip_ms": 0,
                           "offset_contact_ms": 0, "pose_score": None,
                           "stage": "contact"}]
        merged = schema.overlay(self.metadata, edit)
        tagged = [f for f in merged["frames"] if f["stage"] == "contact"]
        self.assertEqual(len(tagged), 1)
        self.assertEqual(tagged[0]["source_ms"], contact_ms)

    def test_a_swing_dir_with_an_edit_reads_as_reviewed(self):
        swing = os.path.join(self.tmp, "swing_001")
        os.makedirs(swing)
        session.write_json(os.path.join(swing, "metadata.json"), self.metadata)
        session.write_json(os.path.join(swing, "user-edit.json"),
                           self._user_edit(stroke="serve"))
        merged, _ = session.load_swing(swing)
        self.assertEqual(merged["labels"]["stroke"], "serve")
```

`session.load_swing` returns `(merged, warnings)` — verified in
`tennisproc/session.py:130-143` — so the tuple unpacking above is correct.

Also add the pinned-hash test from Task 5 Step 5b to this file if it was not
added there.

- [ ] **Step 8: Run both suites**

```bash
npm run typecheck && npx vitest run && npm run lint
.venv313/bin/python -m unittest discover -s tests
```
Expected: frontend green; Python reports 290 tests OK.

- [ ] **Step 9: Verify the real round trip end to end**

```bash
cp -r /Users/wc/.claude/jobs/cff85809/tmp/out /tmp/shotlab-rt
SHOT_LAB_OUT=/tmp/shotlab-rt npm run dev &
sleep 8
curl -s -X PUT localhost:5173/api/swings/IMG_0304/swings/swing_001/user-edit \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/user-edit-sample.json -o /dev/null -w "put: %{http_code}\n"
kill %1
.venv313/bin/python -m tennisproc validate /tmp/shotlab-rt/IMG_0304
.venv313/bin/python -m tennisproc show /tmp/shotlab-rt/IMG_0304/swings/swing_001
```
Expected: `put: 204`; `validate` reports every document valid (now 44, including
the new `user-edit.json`); `show` displays the written labels.

Generate `/tmp/user-edit-sample.json` first by running the write adapter, or by
hand-editing a copy of the fixture with `labels.stroke` set and an `edit` block.

Confirm `metadata.json` was not touched:
```bash
diff /tmp/shotlab-rt/IMG_0304/swings/swing_001/metadata.json \
     /Users/wc/.claude/jobs/cff85809/tmp/out/IMG_0304/swings/swing_001/metadata.json
```
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/domain/etl-write.ts src/domain/etl-write.test.ts tests/test_app_writeback.py vite-plugin-shot-lab.ts src/state/store.ts src/state/etl-source.ts src/state/etl-source.test.ts
git commit -m "Write reviewer labels back to user-edit.json, validated by schema.py"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: ownership table → Task 5/7
route restrictions; authoritative-schema principle → Tasks 2, 3; field mapping →
Task 3; frame identity and sampling → Tasks 2, 3; unlabelled strokes → Tasks 2,
4; `conf` dropped → Task 2 (optional) and Task 3 (never set); transport → Task 5;
thumbnails → Task 6; write-back → Task 7; testing strategy → Tasks 3, 7. Landing
order in the spec matches task order.

**Deferred by the spec, not missing:** classification, production transport,
multi-session browsing, concurrent reviewers, re-crop. `pose.json` skeleton
overlay is listed in the ownership table as a future read and has no task, which
matches "future" in the spec.

**Type consistency.** `sampleFrames`/`adaptSwing`/`adaptSession`/`strokeToApp`/
`stageToPhase`/`qualityToGrade` are named identically where Tasks 3, 6 and 7 use
them. `toUserEdit`'s `gradeToQuality` is the stated inverse of `qualityToGrade`
(2/3/4 against ≤2/3/≥4). `Frame.sourceMs` (Task 2) is the join key in Task 7.
`SwingEntry.hash` (Task 1) feeds `edit.against` (Task 7).

**Known follow-through inside tasks.** Task 5 Step 7 introduces `hydrate` with
`clips` only; Task 7 Step 6 widens it to carry `entries`/`session` and says so
explicitly, including updating the Task 5 test. `loadEtlClips`' return type
changes in the same step. This is called out rather than left to be discovered.

**Two verification steps depend on the local `out/` tree** at
`/Users/wc/.claude/jobs/cff85809/tmp/out` (Tasks 5, 7). If it has been cleaned
up, regenerate with:
`.venv313/bin/python -m tennisproc run ~/Downloads/IMG_0304.MOV --outdir out --pose-backend=stub`

