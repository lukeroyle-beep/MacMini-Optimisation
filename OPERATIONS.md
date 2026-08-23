# Operations and rollback

## Scheduled operation

- `ai.macmini-health` runs every 15 minutes and remains the base health authority. Its deployed script and Git source have matching SHA-256 hashes.
- The observer hook runs after the base snapshot is safely written. Failure is non-blocking and cannot invalidate the established health result.
- `ai.buzz-morning-brief` prepares one brief at 07:15. It does not publish externally.

## Important paths

- Latest observer health: `data/health/latest.json`
- Accepted events: `data/events/accepted/`
- Durable deliveries: `data/events/routes/`
- Quarantine: `data/quarantine/`
- Unified audit: `data/audit/audit.jsonl`
- Project state: `data/project-state/`
- Morning brief: `data/briefs/YYYY-MM-DD.md`
- Observer hook log: `~/.local/state/macmini-ai/buzz-observer.log`

Files are created with user-only permissions where supported. Secret-like keys and common bearer/private-token formats are redacted before audit serialization.

## Manual verification

```sh
cd "/Users/lukesmacminim41/Documents/Apple MacMini Optimisation"
npm test
node src/cli.mjs validate
node src/cli.mjs metrics
launchctl print "gui/$(id -u)/ai.buzz-morning-brief"
```

## Safe rollback

To stop only morning-brief preparation:

```sh
launchctl bootout "gui/$(id -u)/ai.buzz-morning-brief"
```

To stop observer enrichment, remove only the clearly marked `Phase 1 observe-only sidecar` block from both the AI-Ops source and deployed health script, then verify their checksums match. The established health monitor remains intact.

Do not delete event, audit or project-state data during rollback. Preserve it for reconstruction.

## Phase gate

Do not enable A2 until a separately reviewed evidence window shows:

- stable heartbeat execution and no silent loss;
- acceptable false-positive rate;
- durable restart recovery;
- complete audit rows and a valid hash chain;
- Sentinel validation of the proposed recovery runbook;
- explicit approval of each narrow A2 capability.

Reboot autostart, Time Machine configuration, watchdog changes, model assignment changes and HA VM autostart are separate decisions outside this Phase 1 commissioning.
