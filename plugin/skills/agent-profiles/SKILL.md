---
name: agent-profiles
description: Capability profiles for every claude-all agent type plus team-composition presets. Load BEFORE composing an agent team, picking an agent_type for delegation, running /swarm, or answering "which model should do X" in a claude-all session.
---

# claude-all agent profiles & team composition

Ground truth for routing work across the configured agent types. Scores are
1–10 from the 2026-07 model bench (R1–R4, ~/personal/model-bench/results/):
**intel** = how hard a problem it can take unsupervised; **taste** = UI/UX,
code quality, API design, copy; **coach** = how far multi-turn coaching lifts
it above its one-shot class; **cost** = relative burn prior (all subs are
flat-rate — the real constraint is window headroom, see Pools below).

## Roster

| agent_type | model | pool | ctx | intel | taste | coach | cost |
|---|---|---|---|---|---|---|---|
| `fable-5` | claude-fable-5 | anthropic | 1M | 10 | 10 | — | 10 |
| `opus-4-8` | claude-opus-4-8 | anthropic | 1M | 9 | 9 | — | 5 |
| `sonnet-5` | claude-sonnet-5 | anthropic | 1M | 6 | 8 | — | 3 |
| `gpt-5-6-sol` | gpt-5.6-sol | codex | 372K | 9 | 9 | ? | 6 |
| `gpt-5-6-terra` | gpt-5.6-terra | codex | 372K | 7 | 8 | ? | 3 |
| `gpt-5-6-luna` | gpt-5.6-luna | codex | 372K | 7 | 8 | ? | 1 |
| `grok-4-5` | grok-4.5 | grok | 500K | 8 | 9 | 8 | 2 |
| `grok-composer-2-5-fast` | grok-composer-2.5-fast | grok | 200K | 6 | 8 | 9 | 1 |
| `kimi-k2-7-code` | kimi-k2.7-code | kimi | 256K | 4 | 5 | 9 | 1 |
| `gemini-3-5-flash` | gemini-3-flash-agent | agy | 1M | 4 | 6 | 7 | 2 |

These are the ONLY valid agent_type values — do not invent others (no
gpt-5.5, glm, minimax, haiku types exist here).

Roster gaps: Morgan's wider fleet (GPT-5.5, GLM-5.2 976K, minimax-m3 1M,
Opus 4.6-on-agy taste overflow, the Kiro pool) lives on other subs and is
reachable only through driver agents in regular `claude` sessions — never as
a claude-all agent_type. If a task truly needs one of those, say so instead
of substituting.

## Profile cards

- **fable-5** — apex judgment. Judge/synthesizer for bake-offs, hardest
  architecture calls, final review of merged work. Highest burn on the same
  window the lead usually runs on: use one where it decides the outcome, not
  as fan-out labor.
- **opus-4-8** — deep engineer. Hard implementation, gnarly debugging,
  rigorous review. The strongest worker you can fan out more than one of.
- **sonnet-5** — the workhorse. Well-scoped implementation, tests, mechanical
  refactors, docs, verification passes. Default filler for partitioned edit
  work when Anthropic headroom allows.
- **gpt-5-6-sol** — top one-shot coder, near-Fable (bench Elo #1 on one-shot
  medium tasks). Elite on exact specs, mid on open-ended quality: write the
  full spec into the prompt and audit it for internal contradictions.
  Coachability/long-horizon unbenched — prefer it for one-shots.
- **gpt-5-6-terra** — substance play of the 5.6 mid-tier (beats luna
  head-to-head 5-3) with a known spec-miss failure mode: it has shipped
  required behavior in the README instead of compiled source. State the
  deliverable-location contract explicitly and verify output against it.
- **gpt-5-6-luna** — taste/polish play (website Elo #1 in its round). UI,
  frontend, copy, API-surface polish at cost 1. Not for hard logic.
- **grok-4-5** — strong independent all-rounder, biggest judgment-capable
  window (500K). Bulk analysis that still needs thinking, precise-spec heavy
  lifting, cross-provider second opinions; flat-sub relief when the codex
  window is hot. Converges well over turns (coach 8) even without memory.
- **grok-composer-2-5-fast** — fast iterative coder Morgan likes. Coached
  loops and quick sweeps; punches ~4 points above its one-shot class when
  coached. 200K window — keep inputs bounded.
- **kimi-k2-7-code** — the extreme value play: weak one-shot (4/5), coach 9.
  Only deploy in a planned multi-turn loop with the lead reviewing between
  rounds; never one-shot high-stakes work. Privacy gate: never point it at
  personal config/data dirs (~/.claude*, ~/.codex*, dotfiles, shell history).
- **gemini-3-5-flash** — 1M-token extraction engine. Recon, log/codebase
  sweeps, "read everything and report" over huge inputs. Never taste-critical
  work; coaching climbs but regresses en route, so keep tasks single-shot
  and mechanical.

## Pools (rate windows)

Each worker burns its pool's 5h/weekly window, shared with the CLI on that
sub: **anthropic** (fable/opus/sonnet — also what the lead itself burns),
**codex** (sol/terra/luna), **grok** (grok-4-5 + composer), **kimi**,
**agy** (gemini-flash; separate from agy's Claude/GPT pool).

- Before a big fan-out, run `~/.claude-personal/bin/headroom` (one line per
  sub; claude/codex/agy are live reads). Kimi/grok are unobservable — treat
  429s as the signal and back off, don't retry-hammer.
- Effective pressure = max(5h%, weekly%). When quality is a wash, route to
  the pool with more headroom; spread heavy waves across pools.
- Cost is a tie-breaker, not a target: pick the types whose intel/taste meet
  the task's bar, THEN the cheapest/most-headroom of those. A below-bar pick
  that needs rescue costs more than routing right once. Standing permission:
  if cheap output misses the bar, redo with a smarter type without asking.

## Standing rules

Morgan's routing doctrine. claude-all sessions do not load her personal
CLAUDE.md, so this section is authoritative here.

- **Never use Haiku.** Any harness, all day, every day. No haiku agent_type
  exists; do not route around this via raw model names either.
- **Taste-critical or loose briefs** → high-taste types only: `fable-5`,
  `opus-4-8`, `gpt-5-6-sol`, `grok-4-5`, `grok-composer-2-5-fast`. Never
  `gemini-3-5-flash` for taste.
- **Precise-spec heavy lifting** → `grok-4-5` or the codex family; pick by
  window headroom (grok is flat-sub relief for the codex window).
- **The GPT-5.6 family are spec executors**: elite on exact specs, mid on
  open-ended briefs, and contradiction-sensitive — audit the worker prompt
  for internal conflicts before launch.
- **Prompt each model the way its provider intends.** Register matters even
  though the harness handles temp/tools: full guides + cheatsheet at
  `~/personal/model-bench/prompting-guides/CHEATSHEET.md`.
- **Bake-offs are encouraged** for gnarly problems — everything is
  flat-rate; the only real spend is anthropic/codex window headroom.
- **Coached loops change the ranking**: kimi 9, composer 9, grok-4-5 8,
  gemini-flash 7 (climbs but regresses en route). Don't route iterative work
  by the one-shot columns alone — and coaching is a plan, not a rescue.

## Composition presets

Pick the preset shape, then fill roles from the roster by bar + headroom.

- **solo-deep** — one hard, coupled problem. Team of one: `opus-4-8` (or
  `fable-5` if it's the decision itself). Don't parallelize what isn't
  partitionable.
- **bake-off** — gnarly problem, wide solution space. Same self-contained
  spec to 2–4 workers on DIFFERENT pools (`gpt-5-6-sol`, `grok-4-5`,
  `opus-4-8`, optionally `grok-composer-2-5-fast` as the cheap dark horse),
  isolated workspaces; judge with `fable-5` or the lead. Cheap under
  flat-rate — watch the anthropic/codex windows only.
- **review-panel** — independent review of a diff/design. 2–3 read-only
  reviewers from pools OTHER than whatever authored the work (`gpt-5-6-sol`,
  `grok-4-5`, plus `kimi-k2-7-code` as cheap dissent). Lead dedupes and
  adversarially verifies findings before reporting.
- **bulk-sweep** — many independent mechanical items (migrations, per-file
  fixes, per-module audits). Workers: `gemini-3-5-flash` (read-heavy),
  `grok-composer-2-5-fast` or `sonnet-5` (edit-heavy), partitioned with
  disjoint file ownership; bounded waves per /swarm rules.
- **coached-build** — inherently iterative feature work. One
  `kimi-k2-7-code` or `grok-composer-2-5-fast` worker, lead coaches between
  rounds with concrete review notes; plan the rounds up front (coaching is a
  plan, not a rescue).
- **big-context-recon** — inputs too large for the lead. `gemini-3-5-flash`
  (1M) for extraction/inventory; `grok-4-5` (500K) when the reading requires
  judgment. Have them return structured summaries the lead composes.
- **verify-pass** — check claimed-done work. `sonnet-5` workers exercising
  behavior against explicit contracts; `gpt-5-6-terra` for spec-conformance
  audits (give it the contract verbatim).
- **polish-pass** — substance is in, surface isn't. `gpt-5-6-luna` on UI/
  copy/API-surface items; `grok-composer-2-5-fast` as alternate when the
  codex window is hot.

Composition rules of thumb: reviewers never share a pool with the author;
opinion diversity beats redundancy (different pools > same model twice);
match window size to input size before intelligence; every worker prompt is
self-contained (item, output contract, constraints, validation) — workers
don't see this session.
