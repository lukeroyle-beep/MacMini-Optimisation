# Phase 1 discovery and reuse report

## Current stack

- Buzz Desktop 0.5.17 provides channels, threads, members, canvases, agents and the relay-facing collaboration surface.
- Buzz ACP separates persona from runtime. Codex uses the Codex harness; Nova uses Hermes ACP; Rook uses OpenClaw ACP; Fizz, Honey and Forge use local Ollama bridges; Sentinel uses its existing validation bridge.
- OpenClaw 2026.8.1-beta.2 provides a healthy gateway, durable tasks, schedules, approvals, sessions, delivery recovery and an extensive SQLite audit substrate.
- Ollama 0.32.13 serves shared Qwen 3.5 2B, 4B and 9B models with bounded residency. No model needed to be loaded for the Phase 1 checks.
- The version-controlled [AI-Ops health monitor](/Users/lukesmacminim41/Documents/Codex/AI-Ops/bin/health-check.sh) already checks the gateway, channels, Ollama model registration, critical Buzz bindings, Sentinel permission safety, firewall, backup destination and disk capacity every 15 minutes.
- [Existing local routing](/Users/lukesmacminim41/Documents/Buzz%20App/local-routing/README.md) already implements selective Fizz/Honey preprocessing, local Qwen assignments, Sentinel gating and routing telemetry.
- Home Assistant runs as a VirtualBox HAOS guest. Credential-free liveness is verified through `http://homeassistant.local/api/` expecting HTTP 401, plus the HAOS observer on port 4357.
- Tailscale is healthy and does not advertise subnet routes.

## Reused instead of replaced

| Need | Reused component | Phase 1 addition |
|---|---|---|
| User workspace | Buzz channel, members, signed-in UI | Private Macmini Optimisation channel |
| System heartbeat | `ai.macmini-health` | Supplemental process, HA, Tailscale, tasks, memory/load, repository and endpoint projection |
| Durable agent work | OpenClaw tasks and recovery patterns | Neutral event/delivery envelope that does not import private upstream internals |
| Local inference | Shared Ollama service and existing Qwen bindings | Dry-run router telemetry only |
| Validation | Existing Sentinel criteria and safe-failure patterns | Canonical PASS / PASS_WITH_WARNINGS / FAIL / ESCALATE adapter |
| Memory | Buzz knowledge folders and OpenClaw persistence | Concise versioned project-state records with meaningful-change detection |
| Scheduling | launchd and existing heartbeat | One 07:15 deterministic brief preparation job |
| Audit | OpenClaw and local-routing telemetry | Cross-component Phase 1 audit contract including autonomy and validation fields |

## Architectural gaps found

1. Buzz had no shared canonical event, correlation, causation or delivery contract across harnesses.
2. Permissions were primarily prompt- and harness-based; there was no central action-level A0–A4 registry.
3. State was fragmented across chat history, memories, knowledge files and application databases.
4. Sentinel was not connected to a durable, neutral task lifecycle and used legacy outcome names.
5. No single brief consolidated Rook operations, Nova implications, Honey state and Sentinel failures.
6. Model selection reasons and fallback decisions were not uniformly auditable.
7. Buzz persona/runtime drift exists: the team template still references the older builtin Bumble presented as Pollen, while the requested Bumble persona is now a separate agent. Sentinel also shows configuration/runtime drift. Nothing was deleted or silently reconciled.
8. The production local-routing and bridge trees are not Git repositories. This is visible as a software risk.
9. Reboot recovery remains incomplete: FileVault/user login is required, Buzz has no detected login item, and the HA VM does not autostart.
10. The existing Rook watchdog performs `tasks maintenance --apply`; that is pre-existing A2-like behaviour and is not incorporated into this Phase 1 observer.

## Current Mac Mini risks

- No Time Machine destination is configured.
- The 16 GB unified-memory host had healthy pressure during discovery, but the 6.6 GB Qwen 9B model plus a busy Buzz/Codex process tree can materially reduce headroom.
- The Rook watchdog log is approximately 95 MB and lacks observed rotation.
- A stale Home Assistant setup-state note still says installation is pending despite the running VM.

These risks are reported; no backup, login, VM autostart, watchdog or security setting was changed.
