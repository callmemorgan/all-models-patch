---
description: Fan a batch-friendly task out across a native Claude Code agent team
argument-hint: <task>
---

Run the following task in one-shot swarm mode:

<swarm_task>
$ARGUMENTS
</swarm_task>

You are the swarm lead. Use Claude Code's native agent-team tools to execute the
task as a parallel fan-out, then synthesize the workers' results for the user.

Rules:

1. If `<swarm_task>` is empty, stop and ask the user to invoke
   `/claude-all-swarm:swarm <task>`.
2. Briefly inspect only enough to identify independent work items. Do not do the
   main batch work yourself.
3. Load the `agent-profiles` skill (claude-all-swarm:agent-profiles) before
   choosing agent types. Pick a composition preset from it and select only
   agent types present in the current installation's agent bundle, unless the
   user has named models explicitly.
4. Partition as finely as useful, but run the partition in bounded waves.
   Unless the user supplied a lower limit, keep at most 5 workers live at once.
   The cap counts ALL live workers in the session — including ones left over
   from an earlier wave, a redrive, or a prior interrupted swarm — not just
   the ones launched this turn. Before launching any wave, list live workers
   and reconcile: a live worker already assigned an item keeps it (adopt —
   never launch a duplicate for the same item), and orphans from an abandoned
   run get shut down first. When a worker finishes, launch the next queued
   item. A user request for more parallelism is advisory: never exceed a
   provider/session limit reported by the runtime.
   Give every worker a deterministic name of the form
   `<model-prefix>:<item-slug>` so reconciliation after an interruption is
   possible; an unlabeled worker cannot be adopted and will be reaped.
5. Create a team and launch the first wave concurrently. Use the profile-led
   composition from rule 3; fall back to the active model only when no
   configured agent type is clearly better. A named model request MUST be
   implemented by selecting its configured matching `agent_type`; mentioning
   the model only in the worker name or prompt does not change the runtime model.
   Give every worker a self-contained
   prompt with its item, output contract, relevant constraints, and validation.
6. Read-only workers may overlap. Editing workers must have disjoint ownership;
   state each worker's allowed files explicitly. If safe ownership cannot be
   separated, use read-only workers and make the edits yourself after synthesis.
7. Track queued, active, and completed work through the team's task system.
   Refill the wave as workers finish, then wait at the final barrier. If a worker
   returns an empty/malformed response or transient provider error, resume or
   retry that item once after capacity is available — and only after
   confirming the original worker is no longer live (stop it if it is hung).
   After one retry, record a terminal failure rather than retry-hammering.
   One retry means one per item across the whole session, interruptions and
   redrives included. Follow up with an existing worker when its result is
   incomplete instead of silently replacing it.
8. Respect the current permission mode. Never weaken permissions or switch to
   bypass/YOLO automatically. If permissions block the swarm, explain the exact
   approval needed.
9. Shut down the team after collecting results, and verify zero swarm workers
   remain live before reporting — a synthesized answer with workers still
   running in the background is an incomplete shutdown. Report worker
   failures, partial coverage, and any orphans you had to reap, then give one
   concise synthesized answer.
10. If you re-enter mid-swarm (interrupt, redrive, compaction, fresh turn with
    workers already live), your FIRST action is reconciliation per rule 4 —
    never fresh spawning. The failure mode these rules prevent is real:
    unbounded respawning once stacked 40+ live teammates in one session.

This command is Kimi-inspired orchestration over Claude Code agent teams. It is
not Kimi Code's `AgentSwarm` tool and does not promise its 128-worker batch cap,
launch ramp, resume schema, or provider-specific rate-limit scheduler.
