#!/usr/bin/env bash
set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG="$HOME/.openclaw/logs/rook-watchdog.log"
LOCK_DIR="$HOME/.openclaw/locks/rook-watchdog"
JOBS="$HOME/.openclaw/cron/jobs.json"

mkdir -p "$(dirname "$LOG")" "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [[ -f "$LOG" ]] && (( $(stat -f %z "$LOG") > 5242880 )); then
  mv -f "$LOG" "$LOG.1"
fi

{
  printf '===== %s Rook watchdog (observe only) =====\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  openclaw status || true
  openclaw tasks audit || true
  openclaw tasks maintenance --json || true
  openclaw cron list || true
  python3 - "$JOBS" <<'PY'
import json
import sys
import time
from pathlib import Path

path = Path(sys.argv[1])
if not path.exists():
    print("No jobs.json found")
    raise SystemExit(0)

data = json.loads(path.read_text())
jobs = data.get("jobs", data if isinstance(data, list) else [])
now_ms = int(time.time() * 1000)
candidates = []
for job in jobs:
    state = job.get("state", job)
    if not isinstance(state, dict) or not state.get("runningAtMs"):
        continue
    timeout_seconds = job.get("timeoutSeconds") or job.get("payload", {}).get("timeoutSeconds") or 1800
    stale_after_ms = max(int(timeout_seconds) * 2 * 1000, 60 * 60 * 1000)
    age_ms = now_ms - int(state["runningAtMs"])
    if age_ms > stale_after_ms:
        candidates.append({"id": job.get("id"), "name": job.get("name"), "age_minutes": round(age_ms / 60000, 1)})
print(json.dumps({"stale_lock_candidates": candidates, "mutation_performed": False}, sort_keys=True))
PY
} >> "$LOG" 2>&1
