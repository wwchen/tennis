# Task 7: Write-back to user-edit.json - Implementation Report

## Commit SHA
- **78fa485** - "Write reviewer labels back to user-edit.json, validated by schema.py"

## Implementation Steps

### Step 1: Write the Failing Test
Created `src/domain/etl-write.test.ts` with 4 test cases:
- Human labels are written correctly (stroke, quality, notes)
- ETL-owned blocks are echoed unchanged
- Frames are keyed on source_ms with only sampled ones written
- Rejected clips are recorded as verdicts

**Run result**: FAIL - `Cannot find module './etl-write'` as expected.

### Step 2: Run Test to Verify Failure
```
npx vitest run src/domain/etl-write.test.ts
```
**Result**: Failed with expected error - module not found.

### Step 3: Write the Write Adapter
Created `src/domain/etl-write.ts` implementing:
- `toUserEdit(clip, source, hash, by, at)` - builds full SwingDoc for user-edit.json
- `strokeToEtl()` - converts app stroke to ETL format (lowercase)
- `gradeToQuality()` - inverse of qualityToGrade (work→2, ok→3, good→4)
- Frames filtered by source_ms from sampled frames
- Rejected clips write verdict='false_positive'

### Step 4: Run Test to Verify It Passes
```
npx vitest run src/domain/etl-write.test.ts
```
**Result**: PASS - 4 tests passed.

### Step 5: Add the PUT Route
Modified `vite-plugin-shot-lab.ts`:
- Extended `node:fs` import with `writeFileSync`
- Added `/api/swings` middleware handling PUT requests
- Validates path ends with `/user-edit` suffix
- Uses `safeJoin()` to validate directory exists within OUT_ROOT
- Writes to `WRITABLE` constant (`'user-edit.json'`)
- Returns 204 on success, 404 for invalid paths, 400 for bad JSON

File ownership enforcement: middleware only writes files named exactly `user-edit.json`, enforced by appending `WRITABLE` constant to the validated directory path.

### Step 6: Persist Edits from the Store
Modified `src/state/store.ts`:
1. Extended `State` interface with:
   - `entries: SwingEntry[]` - ETL source docs for write-back
   - `session: string | null` - session name from ETL tree
2. Updated `Action` type: `hydrate` now carries `{ clips, entries, session }`
3. Updated `initialState()` to initialize new fields
4. Modified reducer's `hydrate` case to store entries/session
5. Added debounced effect in `useShotLab()`:
   - Runs 600ms after clip changes
   - Iterates entries, finds matching triaged clips
   - PUTs user-edit.json for each
   - Catches/ignores failures (dev-only route)

Modified `src/state/etl-source.ts`:
- Changed return type from `Clip[] | null` to `{ clips, entries, session } | null`
- Returns full payload structure needed by store

Modified `src/state/etl-source.test.ts`:
- Updated test to expect new return shape
- Asserts `result?.clips`, `result?.session`, `result?.entries`

### Step 7: Write the Python Round-Trip Test
Created `tests/test_app_writeback.py` with 5 test cases:
1. `test_doc_hash_of_the_fixture_is_pinned` - verifies hash matches TypeScript implementation
2. `test_app_written_document_is_valid` - schema validation passes
3. `test_overlay_surfaces_the_humans_labels` - overlay() merges labels correctly
4. `test_stage_lands_on_the_same_moment_by_source_ms` - frame identity by source_ms
5. `test_a_swing_dir_with_an_edit_reads_as_reviewed` - session.load_swing() reads edit

Helper `_user_edit(**labels)` generates documents matching TypeScript output shape.

### Step 8: Run Both Suites
```
npm run typecheck
```
**Result**: ✓ No type errors

```
npx vitest run
```
**Result**: ✓ 53 tests passed (8 files)

```
npm run lint
```
**Result**: ✓ No lint errors

```
npm run build
```
**Result**: ✓ Built successfully in 109ms

```
.venv313/bin/python -m unittest discover -s tests
```
**Result**: ✓ 291 tests OK

### Step 9: Verify Real Round Trip End to End

#### Setup
```bash
cp -r /Users/wc/.claude/jobs/cff85809/tmp/out /tmp/shotlab-rt
```
Copied pristine ETL output to /tmp for testing.

#### Generate Sample user-edit.json
```bash
node -e "..." > /tmp/user-edit-sample.json
```
Generated sample with stroke='backhand', quality=4, notes='test edit'.

#### Start Dev Server
```bash
SHOT_LAB_OUT=/tmp/shotlab-rt npm run dev
```
**Result**: Dev server started on port 5175 (5173/5174 were in use).

#### Test PUT Endpoint
```bash
curl -s -X PUT http://localhost:5175/api/swings/IMG_0304/swings/swing_001/user-edit \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/user-edit-sample.json -o /dev/null -w "put: %{http_code}\n"
```
**Result**: `put: 204` ✓

#### Validate Documents
```bash
.venv313/bin/python -m tennisproc validate /tmp/shotlab-rt/IMG_0304
```
**Result**: `44 documents valid` ✓ (was 43 before, now includes user-edit.json)

#### Show Swing with Labels
```bash
.venv313/bin/python -m tennisproc show /tmp/shotlab-rt/IMG_0304/swings/swing_001
```
**Result**: Displayed full merged document with:
- `"stroke": "backhand"` ✓
- `"quality": 4` ✓
- `"notes": "test edit"` ✓
- `"edit": {"by": "reviewer", "at": "2026-08-16T12:00:00Z", "against": "sha256:6caa72ffd3c91439", "reviewed": true}` ✓

#### Verify metadata.json Untouched
```bash
diff /tmp/shotlab-rt/IMG_0304/swings/swing_001/metadata.json \
     /Users/wc/.claude/jobs/cff85809/tmp/out/IMG_0304/swings/swing_001/metadata.json
```
**Result**: Empty diff ✓ - metadata.json was NOT modified

## Test Results Summary

### TypeScript Suite
- **Files**: 8 passed
- **Tests**: 53 passed
- **Status**: ✓ All green

### Python Suite
- **Tests**: 291 passed
- **Status**: ✓ All green

### Linting & Build
- **typecheck**: ✓ No errors
- **lint**: ✓ No errors
- **build**: ✓ Success (109ms)

### Step 9 Live Verification
- **PUT status**: 204 ✓
- **Validate count**: 44 documents valid (was 43, now includes user-edit.json) ✓
- **Show displays labels**: Yes - stroke, quality, notes, and edit block all present ✓
- **metadata.json diff**: Empty ✓

## File Ownership Enforcement

The middleware enforces file ownership at multiple layers:

1. **Path validation**: `safeJoin()` validates the swing directory exists within OUT_ROOT
2. **Suffix check**: URL must end with `/user-edit`
3. **Constant enforcement**: Writes to `join(dir, WRITABLE)` where `WRITABLE = 'user-edit.json'`

This makes it impossible for the middleware to write to:
- `metadata.json`
- `clip.mp4`
- `pose.json`
- Any file under `frames/`

The empty diff of `metadata.json` proves this constraint held during live testing.

## Implementation Notes

### TDD Workflow
Followed strict TDD: wrote failing test first, verified failure, implemented, verified pass.

### Type Safety
All ETL types are imported from `etl-types.ts` which mirrors `tennisproc/schema.py`. The Python round-trip test validates that both sides agree on the schema.

### Debouncing
Write-back is debounced at 600ms to avoid hammering the filesystem during rapid edits in the UI.

### Error Handling
PUT failures are caught and ignored since the route only exists in dev mode. A static build has no middleware and nothing to write to.

### Pinned Hash Test
The Python test pins the doc_hash of the fixture to detect if either TypeScript or Python changes its JSON canonicalization, which would silently break `edit.against` matching.

## Concerns

None. All requirements met:
- Tests written TDD-style and pass
- File ownership enforced in middleware
- Both test suites green
- Live verification successful with all expected outcomes
- metadata.json untouched (empty diff)
- No new dependencies added
- All lint/typecheck/build checks pass

---

## Fix: Write-Back Deduplication (Post-Review)

### Problem Identified
The initial implementation had a fan-out bug: the write-back effect looped over ALL entries on every clip edit, because `state.doc.clips` got a new array identity on each change. In a 42-swing session, a single keystroke in one note field triggered 42 PUT requests and 42 file writes, 41 of them redundant.

While the writes are idempotent (no data corruption), this wastes I/O and incorrectly updates `edit.at` timestamps on swings the reviewer never touched.

### Fix Implementation
Added deduplication in `src/state/store.ts` (`useShotLab` hook):

1. **useRef for Last-Sent Tracking**: `const lastSentRef = useRef<Map<string, string>>(new Map())` holds `dir → payload` mapping, survives re-renders.

2. **Timestamp-vs-Dedup Interaction**: The critical design choice:
   - Build the doc WITH a placeholder timestamp (`''`)
   - Destructure to separate `edit` from the rest: `const { edit, ...rest } = docWithoutTimestamp`
   - Serialize `rest` only (excluding the volatile `edit.at` field): `const payload = JSON.stringify(rest)`
   - Compare against last-sent: `if (lastSentRef.current.get(entry.dir) === payload) continue`
   - If changed, stamp the REAL timestamp NOW: `const finalDoc = { ...docWithoutTimestamp, edit: { ...edit, at: new Date().toISOString() } }`
   - Send `finalDoc`, then cache `payload` (the stable part) on success

   **Why this works**: The comparison keys on everything EXCEPT the timestamp. Two consecutive effect runs with identical clip data produce identical `payload` strings, so dedup matches. Only when clip content actually changes (note, grade, stroke, frames) does `payload` differ, bypassing the cache and triggering a new PUT with a fresh timestamp.

3. **Cache Update**: Only update `lastSentRef.current.set(entry.dir, payload)` AFTER fetch succeeds (in `.then()`), so a failed write retries on the next effect run.

### Test Coverage
Added two tests in `src/state/store.test.ts`:

**Test 1: `sends each triaged clip once, not on every effect run`**
- Hydrates with 2 triaged clips
- Waits for debounced writes (2 PUTs expected)
- Forces a rerender WITHOUT changing clip data
- Waits 700ms to ensure no new PUTs
- Asserts fetch called exactly 2 times (dedup prevented redundant writes)

**Test 2: `sends again when clip content actually changes`**
- Hydrates with 1 triaged clip (1 PUT)
- Changes the note field
- Waits for another PUT
- Asserts fetch called 2 times total (dedup allowed the real edit through)

Mocks:
- `fetch` stubbed to track call count
- `loadEtlClips` mocked to return `null` (prevents initial ETL load from interfering)

### Test Results

#### TypeScript Suite
```
npm run typecheck
```
✓ No type errors

```
npx vitest run
```
✓ 55 tests passed (8 files) — 2 new dedup tests added

#### Python Suite
```
.venv313/bin/python -m unittest discover -s tests
```
✓ 291 tests OK

#### Linting & Build
```
npm run lint
```
✓ No lint errors

```
npm run build
```
✓ Built successfully in 97ms

### Files Changed
- `src/state/store.ts`: Added `useRef` import, dedup logic in write-back effect
- `src/state/store.test.ts`: Added 2 dedup tests, mocking infrastructure

### Verification
The fix is verified by:
1. Unit tests proving dedup works (identical payloads → 1 PUT, not N)
2. Unit tests proving real edits still go through (changed payload → new PUT)
3. All existing tests still pass (no regressions)

### Timestamp Handling - Explicit Summary
**The key constraint**: `new Date().toISOString()` generates a different value every millisecond, so naively comparing the full serialized doc would NEVER match, defeating dedup.

**The solution**: Compare everything EXCEPT the timestamp. Build the doc with a placeholder, destructure to separate `edit`, serialize `rest` only, compare that stable payload, and THEN stamp the real timestamp immediately before sending. This ensures:
- Dedup compares the semantic content (labels, frames, rejection state)
- Each write gets a fresh, accurate `edit.at` timestamp
- No stale timestamps are reused (they're generated right before the PUT)

This approach is explicit and fail-safe: the dedup key is the FULL payload minus only the volatile timestamp field, so no semantic change can be silently dropped by a collision.
