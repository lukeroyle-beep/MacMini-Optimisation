# Rook watchdog governance review

## Verdict

`uk.rook.watchdog` is operationally healthy but is not compatible with the Phase 1 A0/A1 boundary. It runs every 15 minutes and performs two state-changing actions without a phase gate, approval record, or Sentinel validation:

1. `openclaw tasks maintenance --apply` can reconcile, stamp, prune, and recover task data.
2. Its embedded Python edits `~/.openclaw/cron/jobs.json` directly to clear stale `runningAtMs` values.

The second path does create a backup, but the write is not atomic, is not coordinated with OpenClaw, and does not revalidate state immediately before mutation. All command failures are suppressed, and the primary log has grown to approximately 91 MB without rotation.

The 2026-08-23 read-only maintenance preview found no active tasks, stale tasks, audit errors, TaskFlow defects, or pending maintenance. There is no current incident requiring automated repair.

## Required gate before continued mutation

- Replace the live job with the prepared observe-only candidate in `proposals/rook-watchdog-observe-only.sh`.
- Preserve read-only status, audit, maintenance preview, cron listing, and stale-lock detection.
- Rotate the log and prevent overlapping runs.
- Route detected repair candidates into the Phase 1 event/audit path for review.
- Reintroduce only named repair actions under explicit, narrow A2 approvals with before/after evidence, atomic operations, rollback, and Sentinel validation.

The candidate is prepared but not deployed. Deployment changes an existing automation and therefore remains a separate approval decision.
