# Phase 1 architecture

```text
ai.macmini-health (launchd, 15 min)
        |
        +-- established deterministic checks
        |
        +-- Phase 1 observer enrichment (A0)
                |
                +-- health/latest.json
                +-- canonical event bus
                |      +-- event ID dedupe
                |      +-- correlation / causation
                |      +-- hop limit 8
                |      +-- 32 dispatches per correlation
                |      +-- durable route envelopes / leases
                |
                +-- autonomy registry (A0-A4)
                +-- hash-chained audit
                +-- incidents / project state
                +-- Sentinel outcome adapter
                +-- deterministic telemetry

07:15 launchd schedule
        |
        +-- one local morning brief (A1 prepare-only)
```

## Event contract

Every accepted event contains a schema version, event ID, type, source, severity, timestamp, resource, object payload, correlation ID, optional causation ID, hop count, route path and canonical hash.

Publishing uses an exclusive durable file claim. Identical replay is deduplicated. An event-ID/content conflict, malformed payload, unknown type, payload over 256 KiB, payload deeper than 32 levels, forbidden prototype keys, or hop-limit breach is quarantined without dispatch. Correlation dispatch is serialized and capped at 32.

Delivery state is independent from chat. It supports queued, running, succeeded and dead-letter states; 60-second leases; three attempts; restart reclaim; and repeated-failure routing to Rook. Phase 1 prepares delivery envelopes but does not autonomously invoke consequential agent actions.

## Action-level autonomy

- A0: deterministic read-only checks may execute.
- A1: internal proposals, events, project state, audit and briefs may be prepared.
- A2: denied by the Phase 1 gate, including service restart and job retry.
- A3: executor is not invoked; a pending `approval.required` event is routed to Codex.
- A4: prohibited even if a caller supplies an apparent approval.
- Unknown capabilities: denied.

The registry classification wins over an event's or agent's claimed classification.

## Sentinel

Legacy results are adapted as follows:

| Existing | Canonical |
|---|---|
| PASS | PASS |
| PASS_WITH_NOTES | PASS_WITH_WARNINGS |
| REWORK | FAIL |
| ESCALATE | ESCALATE |

Missing evidence or malformed validation fails safely to ESCALATE. FAIL returns to the originating agent under its existing lieutenant; it does not immediately notify the user.

## Model routing prototype

[config/model-routing.prototype.json](/Users/lukesmacminim41/Documents/Apple%20MacMini%20Optimisation/config/model-routing.prototype.json) is dry-run only. It demonstrates that persona, role, permissions, tools, memory and selected model can remain separate. It prefers 2B for trivial classification, 4B for routine/compression, 9B for bounded coding/reasoning, and the frontier model for difficult or strategic work. Privacy, context, coding, tool availability, explicit cloud fallback and provider availability are logged as deterministic reasons.

It cannot call a model and does not change the current production assignments.

## Persistence choice

The Phase 1 sidecar uses small atomic files and exclusive claims rather than writing into Buzz or OpenClaw-owned databases. This keeps ownership clear and makes every accepted event and route inspectable. Restart recovery scans for accepted events without route envelopes. A future migration to one SQLite WAL store is possible behind the same interfaces if higher write concurrency becomes necessary.
