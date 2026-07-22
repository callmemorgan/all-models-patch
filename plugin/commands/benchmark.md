---
description: Benchmark raw response latency and token rates across configured claude-all agents
argument-hint: [--agents name1,name2] [--warmups N] [--runs N] [--seed VALUE]
---

Run the deterministic claude-all raw response benchmark with these arguments:

<benchmark_arguments>
$ARGUMENTS
</benchmark_arguments>

Use Bash to invoke:

```bash
all-models-patch benchmark $ARGUMENTS
```

This command is a thin wrapper around the external benchmark harness. Do not
create an agent team, spawn teammates yourself, substitute model names, or
reimplement the timing logic. The harness runs configured agents serially and
defaults to every agent in the live bundle, one warmup, and three measured
requests each.

Respect the current permission mode. If Bash is blocked, report the exact
approval needed instead of changing permissions. When the command finishes,
summarize failures or exclusions and give the artifact directory printed by the
harness. Exit status 2 means a completed partial benchmark, not a harness crash.
