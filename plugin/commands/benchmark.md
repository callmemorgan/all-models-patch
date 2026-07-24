---
description: Benchmark raw response latency and token rates across configured claude-all agents
argument-hint: [--agents name1,name2] [--warmups N] [--runs N] [--seed VALUE] [--fixture raw-v1|aa-long-v1|aa-story-v1] [--compare-aa extract.json]
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

Optional flags:

- `--fixture raw-v1|aa-long-v1|aa-story-v1` selects the workload. `raw-v1`
  (default) is the short 256-line calibration prompt. `aa-long-v1` is an
  Artificial Analysis–shaped long-context fixture (~10k input tokens, 48-line
  output) with client-side TTFAT (`ttfatMS`). `aa-story-v1` keeps the ~10k-token
  input but asks for free-form prose (1500+ words) — the throughput fixture:
  validity is a visible-character floor, and the summary ranks on
  tokenizer-neutral chars/s because identical text tokenizes differently per
  provider.
- `--compare-aa <extract.json>` appends a local-vs-AA comparison section to
  `summary.md` from a previously extracted AA JSON file (no network). The first
  variant under each agent supplies AA TTFAT and output tok/s.

Respect the current permission mode. If Bash is blocked, report the exact
approval needed instead of changing permissions. When the command finishes,
summarize failures or exclusions and give the artifact directory printed by the
harness. Exit status 2 means a completed partial benchmark, not a harness crash.
