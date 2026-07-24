---
description: Rank configured agents for a task using capability, speed, reliability, and quota
argument-hint: [--preset <id|alias>] [--weights <json>] [--provider <list>] [--exclude-provider <list>] [--prefer-provider <list>] [--all] [--json]
---

Rank configured agents for the current task with these arguments:

<recommend_arguments>
$ARGUMENTS
</recommend_arguments>

Use Bash to invoke:

```bash
all-models-patch recommend $ARGUMENTS
```

This command is a thin wrapper around the recommendation harness. Do not
re-rank, second-guess scores, invent weights, or substitute agent names. Scores
blend Artificial Analysis capability indices, local benchmark speed and
reliability, live quota state, context fit, and the user's weight settings from
the recommendations dashboard.

Selection contract (always apply before running):

1. The user's own words choose the preset. Mode words map as follows:
   `balanced` → `balanced` (default when no mode word appears);
   `fast` → `fast-recon`; `tasteful` / `taste` → `taste-polish`;
   `efficient` / `cheap` → `quota-saver`; `deep` / "do it right" → `deep-build`.
   Built-in presets: `balanced`, `deep-build`, `taste-polish`, `fast-recon`,
   `quota-saver`.
2. Provider words come in three strengths only:
   "only \<pool\>" → `--provider`;
   "not" / "off \<pool\>" → `--exclude-provider`;
   "try to use \<pool\>" → `--prefer-provider` (mutually exclusive with
   `--provider`). Provider aliases: `agy`→`antigravity`, `anthropic`→`claude`,
   `xai`→`grok`, `openai`→`codex`, `moonshot`→`kimi`.
3. Announce the chosen preset and filters in one line and why. Never choose
   silently. Always defer to the user's explicit wording.
4. Project-instruction constraints (provider gates, standing policies) veto
   rankings — a high score never overrides a stated constraint.

Bare invocation prints the preset menu (`id`, `whenToUse`, `cues`) then the
balanced ranking. Output has a header (preset, generated timestamp, benchmark
provenance, quota-cache age), ranked lines (rank, agent, score, top-3 dimension
contributions with sources; preferred rows show `(preferred +8)`), and an
ineligible trailer. Relay that output faithfully. If the command fails (unknown
preset or provider), show the error's list of valid options.

Respect the current permission mode. If Bash is blocked, report the exact
approval needed instead of changing permissions.
