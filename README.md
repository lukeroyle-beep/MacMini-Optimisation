# Buzz Macmini Optimisation — Phase 1

This project is the observe-only control substrate for Buzz on the Mac Mini.

It extends the existing Buzz, OpenClaw and AI-Ops stack without modifying their databases or changing production model assignments. Phase 1 permits A0 observation and A1 preparation only. A2 recovery actions are denied, A3 actions become approval requests routed to Codex, and A4 actions are always prohibited.

## What is active

- Private Buzz channel `Macmini Optimisation` (`63d8f899-ee39-4556-8435-c8146c3cdb22`) with Luke, Codex, Nova, Rook, Bumble, Honey, Fizz, Forge and Sentinel.
- Deterministic heartbeat enrichment invoked by the existing `ai.macmini-health` job every 15 minutes.
- Durable loop-safe events, delivery leases, incident records, project state, a hash-chained audit log and telemetry.
- A daily 07:15 launchd job that prepares one consolidated morning brief locally.
- A dry-run model-routing prototype. It records selection reasons but cannot call a model or alter an agent assignment.
- Independent Sentinel verdict: `PASS WITH WARNINGS` for Phase 1; 33/33 tests pass.

## Quick checks

```sh
npm test
node src/cli.mjs validate
node src/cli.mjs heartbeat
node src/cli.mjs brief
node src/cli.mjs metrics
```

The generated morning brief is [data/briefs/2026-08-23.md](/Users/lukesmacminim41/Documents/Apple%20MacMini%20Optimisation/data/briefs/2026-08-23.md). Full operating details are in [OPERATIONS.md](/Users/lukesmacminim41/Documents/Apple%20MacMini%20Optimisation/OPERATIONS.md).

## Deliberate boundary

The morning brief is prepared but not automatically published to Buzz. Publication needs a supported non-interactive Buzz credential/identity injection path. No private key is copied into this project or a launchd environment.

Phase 2 and all A2 permissions remain gated on measured reliability and a separate approval decision.
