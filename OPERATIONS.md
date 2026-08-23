# Operations and rollback

## Scheduled operation

- `ai.macmini-health` runs every 15 minutes and remains the base health authority. Its deployed script and Git source have matching SHA-256 hashes.
- The observer hook runs after the base snapshot is safely written. Failure is non-blocking and cannot invalidate the established health result.
- `ai.buzz-morning-brief` prepares one deterministic brief at 07:15 and publishes it once to the private `Macmini Optimisation` channel as Honey. The existing Keychain identity is read at runtime; no private key is stored in this repository.
- `ai.buzz-desktop-keepalive` starts Buzz after login and reopens it after an unexpected exit.
- `ai.home-assistant-after-login` starts the existing Home Assistant VM after login when it is not already running.

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

Time Machine reformatting, watchdog replacement deployment and model assignment changes remain separate decisions outside the original Phase 1 commissioning.

## Scoped owner approvals after commissioning

- Automatic private-channel morning-brief publication is a single scoped A2 exception authorised by Luke on 2026-08-23. It does not raise the general autonomy ceiling; all other A2 capabilities remain denied.
- After-login recovery for Buzz and the existing Home Assistant VM is explicitly authorised. FileVault remains enabled, so a human login is still required after a cold reboot.
- The Rook watchdog has been reviewed separately. Its observe-only replacement is prepared but is not deployed without a further change approval; see `WATCHDOG_GOVERNANCE.md`.
