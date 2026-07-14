---
name: agent-profiles
description: Inspect the current claude-all agent bundle and choose a safe team shape. Load before composing an agent team, selecting an agent_type, or running /swarm.
---

# claude-all agent profiles and team composition

Agent availability is installation-specific. Treat the agent definitions
supplied to the current `claude-all` session as the source of truth. If needed,
inspect `~/.cli-proxy-api/claude-all-agents.json`, but never print credentials
or unrelated local configuration.

## Selection rules

- Use only an `agent_type` that exists in the current agent bundle. Never infer
  a type from a model name or invent a fallback type.
- Match the worker's documented description and capabilities to the task.
- Respect model/provider limits reported by the runtime. Do not assume a
  particular subscription, quota, benchmark score, or local helper exists.
- Prefer independent providers or model families for review diversity when the
  configured roster makes that possible.
- If the requested model has no configured agent type, explain that constraint
  instead of silently substituting another model.

## Composition presets

- **solo-deep** — one tightly coupled architecture, implementation, or debugging
  problem. Use one capable worker.
- **bake-off** — a hard problem with several credible approaches. Give the same
  self-contained brief to two or three suitable, diverse workers and have the
  lead judge the results.
- **review-panel** — independent read-only review of a design or diff. Use two
  or three suitable workers; the lead reproduces findings before reporting.
- **bulk-sweep** — independent mechanical items. Partition files or items with
  disjoint edit ownership and refill a bounded worker wave as slots open.
- **coached-build** — iterative feature work. Keep one worker and provide
  concrete review feedback between rounds.
- **big-context-recon** — large-input inventory or extraction. Select a worker
  whose configured context window and description fit the input.
- **verify-pass** — exercise completed work against explicit contracts and
  report reproducible failures.
- **polish-pass** — improve copy, UX, or API surface after behavior is complete.
  Select a worker explicitly described as strong at that kind of judgment.

## Execution rules

- Keep at most five workers live unless the runtime reports a lower limit.
- Every prompt must include the item, output contract, constraints, relevant
  context, and validation steps.
- Read-only workers may overlap. Editing workers need explicit, disjoint file
  ownership.
- Retry a transient or malformed worker result at most once. Report terminal
  failures and partial coverage.
- The lead remains responsible for synthesis and adversarial verification.
