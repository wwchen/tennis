#!/usr/bin/env bash
#
# Process every video in raw/ into out/, reproducibly.
#
# One command, one settings block, one manifest. The point is that a tree in
# out/ can always answer "what produced me" -- this project spent a day with
# six sessions rendered by four different versions of the detector and no way
# to tell which was which from the files.
#
#   scripts/process.sh                 # everything in raw/
#   scripts/process.sh IMG_0304        # just these
#   SETTINGS="--fps 0 --span 1.6" scripts/process.sh IMG_0304
#
# SETTINGS reaches `tennisproc run` verbatim, so only flags it defines fit
# here. The scan's own knobs (scan_k, scan_fps, audio_window_s, detector,
# pose_min_confidence) have no flags and are edited in tennisproc/config.py.
#
# Re-running is cheap where it can be: the pose scan and the per-swing pose
# windows are both cached under out/<stem>/work/, keyed by a hash of every
# setting that could change them. Changing a render knob re-renders only.
set -uo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
OUT=${OUT:-out}
JOBS=${JOBS:-3}
# Render settings. Detector settings live in tennisproc/config.py, where each
# one carries the measurement that chose it.
SETTINGS=${SETTINGS:-"--fps 2 --span 3.0 --crop full"}

stems=("$@")
if [ ${#stems[@]} -eq 0 ]; then
  stems=()
  for f in raw/*.MOV raw/*.mov raw/*.mp4; do
    [ -e "$f" ] || continue
    stems+=("$(basename "${f%.*}")")
  done
fi

mkdir -p "$OUT"
MANIFEST="$OUT/manifest.jsonl"
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
DIRTY=$(git status --porcelain 2>/dev/null | head -1)
[ -n "$DIRTY" ] && COMMIT="$COMMIT+dirty"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "commit $COMMIT   settings $SETTINGS   sessions ${#stems[@]}"

run_one() {
  local stem="$1" log="$OUT/$stem/run.log"
  local src=""
  for ext in MOV mov mp4 MP4; do
    [ -e "raw/$stem.$ext" ] && src="raw/$stem.$ext" && break
  done
  [ -z "$src" ] && { echo "  $stem: no video in raw/"; return 1; }

  mkdir -p "$OUT/$stem"
  local t0=$SECONDS
  if $PY -m tennisproc run "$src" --outdir "$OUT" $SETTINGS >"$log" 2>&1; then
    local n; n=$(ls "$OUT/$stem/swings" 2>/dev/null | wc -l | tr -d ' ')
    printf '{"session":"%s","commit":"%s","settings":"%s","started":"%s","seconds":%d,"swings":%s,"ok":true}\n' \
      "$stem" "$COMMIT" "$SETTINGS" "$STARTED" "$((SECONDS-t0))" "$n" >>"$MANIFEST"
    echo "  $stem: $n swings in $((SECONDS-t0))s"
  else
    printf '{"session":"%s","commit":"%s","settings":"%s","started":"%s","ok":false}\n' \
      "$stem" "$COMMIT" "$SETTINGS" "$STARTED" >>"$MANIFEST"
    echo "  $stem: FAILED -- see $log"
  fi
}

# Throttle by polling, not by `wait -n`: macOS ships bash 3.2 and `wait -n`
# arrived in 4.3, so there it fails instantly with "invalid option" -- turning
# this loop into a busy-wait that spins a core and floods the terminal with
# errors while pretending to be a job limiter.
for stem in "${stems[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 1; done
  run_one "$stem" &
done
wait

echo
$PY scripts/evaluate.py "$OUT" "${stems[@]}"
