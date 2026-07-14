# All Models Patch

`all-models-patch` is a personal macOS harness for running Claude Code against
multiple model providers through a local gateway. It keeps Claude Code's normal
terminal agent loop and tools while fixing client assumptions that otherwise
hide non-Anthropic models, apply the wrong context limits, or attribute their
commits to Claude.

The day-to-day command is `claude-all`. It launches a pinned, verified Claude
Code binary with an isolated profile and connects it to a separately running
[CLIProxyAPI](https://github.com/callmemorgan/CLIProxyAPI) instance.

This repository is intentionally fail-closed and machine-specific. It patches
one known Claude Code arm64 build, expects a local gateway and model metadata,
and refuses to launch when the stock binary or patched runtime no longer
matches its recorded fingerprints.

## Companion proxy

This project is designed to run with
[`callmemorgan/CLIProxyAPI`](https://github.com/callmemorgan/CLIProxyAPI), its
companion server-side fork. The two repositories form a matched pair:

- `all-models-patch` fixes Claude Code's client-side discovery, context,
  compaction, and attribution behavior.
- `callmemorgan/CLIProxyAPI` authenticates and routes provider requests,
  advertises real model IDs, preserves those IDs in responses, exposes
  sanitized subscription quota windows, and adds operational diagnostics.

Using the client patch with an unmodified proxy would lose part of that
contract, especially stable real model identities and the usage endpoint.
Using the proxy fork without the client patch would leave Claude Code's
non-Anthropic model filter and client-side context assumptions in place.

## What it changes

The patched runtime makes four targeted changes to Claude Code:

| Area | Stock behavior | Patched behavior |
| --- | --- | --- |
| Gateway discovery | Keeps only model IDs beginning with `claude` or `anthropic` | Keeps every model returned by the configured gateway |
| Context windows | Falls back to Claude-oriented defaults for unknown models | Reads a validated per-model context limit from the launch environment |
| Compaction | Uses Claude-oriented automatic compaction thresholds | Reads a validated per-model compaction threshold from the launch environment |
| Git attribution | Credits unknown models as Claude with an Anthropic email | Credits the active model and records that this harness was used |

The current attribution block looks like this:

```text
Generated-With: @callmemorgan/all-models-patch
Co-Authored-By: gpt-5.6-sol <noreply@openai.com>
```

The model family determines the email:

| Model ID prefix | Attribution email |
| --- | --- |
| `claude`, `anthropic` | `noreply@anthropic.com` |
| `gpt`, `codex` | `noreply@openai.com` |
| `gemini` | `gemini-code-assist[bot]@users.noreply.github.com` |
| `grok` | `grok@x.ai` |
| `kimi` | `noreply@moonshot.ai` |
| `minimax` | `noreply@minimax.io` |
| `glm` | `noreply@z.ai` |
| anything else | `noreply@unknown.invalid` |

Claude models retain Claude Code's friendly display names. Other providers use
the exact model ID reported by the gateway. Setting `attribution.commit` still
overrides the generated block, and setting `includeCoAuthoredBy` to `false`
still disables it.

## How the pieces fit together

```text
claude-all
  |
  |-- verifies ~/.local/share/claude-all/current/claude
  |-- loads ~/.claude-all as an isolated Claude Code profile
  |-- exports per-model context and compaction settings
  |-- loads the claude-all-swarm plugin and configured agent types
  |
  v
patched Claude Code runtime
  |
  |  Anthropic-compatible HTTP on 127.0.0.1:8317
  v
CLIProxyAPI
  |
  +-- Anthropic models
  +-- OpenAI/Codex models
  +-- Gemini models
  +-- Grok models
  +-- Kimi models
  +-- Ollama Cloud models such as MiniMax and GLM
```

The responsibilities are deliberately separate:

- This repository owns the Claude Code launcher, binary analyzer and patcher,
  runtime verification, context-map validation, usage helper, and swarm plugin.
- CLIProxyAPI owns provider authentication, routing, model discovery, response
  translation, agent definitions, and the live gateway service.
- `~/.claude-all` owns Claude Code settings, sessions, plugins, project state,
  and global `CLAUDE.md` instructions for this profile.
- `~/.cli-proxy-api` owns the local client key, agent bundle, and active context
  map. Those files are not committed here.

## Supported runtime

The checked-in fingerprints currently support:

- macOS on arm64
- Claude Code `2.1.197`
- stock binary SHA-256
  `8cc0c4d1e4eb1dca3b0cc92ab02ee3505de764e023f8c901761c167b72041fb8`
- Node.js 20 or newer
- the macOS `codesign` command

The stock runtime is expected at:

```text
~/.local/share/claude-stable/current/claude
```

The patched runtime and manifest are written under:

```text
~/.local/share/claude-all/versions/2.1.197/
~/.local/share/claude-all/current -> versions/2.1.197
```

A Claude Code upgrade is not automatically trusted. The analyzer must first be
updated with the new binary hash, semantic fingerprints, and expected call
counts. Until then, analysis, building, verification, and `claude-all` fail.

## Required local configuration

`claude-all` expects all of the following to exist:

```text
~/.cli-proxy-api/client-key
~/.cli-proxy-api/claude-all-agents.json
~/.cli-proxy-api/claude-all-contexts.json
~/.local/bin/verify-claude-all-runtime
~/.local/bin/prepare-claude-context-env
```

It also expects CLIProxyAPI to be listening on `http://127.0.0.1:8317` and to
support Anthropic-compatible model discovery and messages.

The context-map schema is demonstrated in
[`config/claude-all-contexts.example.json`](config/claude-all-contexts.example.json).
Only entries with `status: "route-validated"` are exported. Each entry must
provide:

- `contextTokens`: an integer from 100,000 through 1,048,576
- `compactAtTokens`: an integer from 100,000 up to, but not including, the
  context limit

Invalid entries are ignored with warnings. The launcher converts valid entries
to `CLAUDE_ALL_CONTEXT_<model-id>` and `CLAUDE_ALL_COMPACT_<model-id>`
environment variables consumed by the patched runtime.

This checkout is wired to `/Users/morgan/personal/all-models-patch` in
`bin/claude-all`. A clone in another location must update `swarm_plugin` or
make that path configurable before installing the launcher.

## Build and verify

Install no npm dependencies; the project uses Node's standard library.

```bash
npm test
npm run check
npm run patch:analyze
npm run patch:build
npm run patch:verify
```

`patch:build` performs the complete promotion flow:

1. Verify the stock Mach-O architecture, SHA-256, offsets, semantic
   neighborhoods, and resolver call counts.
2. Copy the stock binary to a temporary target.
3. Replace each expected byte sequence exactly once.
4. Verify that every patched sequence exists exactly once and every original
   sequence is gone.
5. Ad-hoc sign the binary and verify its signature.
6. Run the patched binary's `--version` command.
7. Write a manifest containing stock and patched hashes, patcher version,
   offsets, architecture, and build time.
8. Atomically promote the version directory through the `current` symlink.

The launcher calls `verify-claude-all-runtime` on every start. Verification
checks the stock hash, patched hash, expected patched bytes, and code signature
before returning the executable path.

## Run

From any project directory:

```bash
claude-all
```

Inside Claude Code, use `/model` to choose any model returned by the gateway.
Model IDs remain unchanged end to end, including in session transcripts and
resume metadata.

The launcher sets:

- `CLAUDE_CONFIG_DIR=~/.claude-all`
- `ANTHROPIC_BASE_URL=http://127.0.0.1:8317`
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- `DISABLE_UPDATES=1`

It passes the configured agent bundle with `--agents` and loads this
repository's plugin with `--plugin-dir`.

## Swarm command

The plugin provides:

```text
/claude-all-swarm:swarm <task>
```

The command uses Claude Code's native team primitives to split batch-friendly
work into bounded waves, keep at most five workers active by default, collect
their results, and synthesize a final response. Workers are selected from the
agent types supplied to Claude Code by the configured agent bundle.

This is local orchestration, not Kimi Code's `AgentSwarm` implementation. It
does not claim Kimi's worker cap, launch scheduler, or resume contract, and it
never weakens the current permission mode automatically.

## Subscription usage cache

Refresh the gateway's sanitized usage data with:

```bash
claude-all-usage
```

Options:

```text
--json
--cached
--provider=codex,grok,agy,kimi
```

The helper calls `http://127.0.0.1:8317/v1/subscription-usage` with the local
client key and atomically writes percentages, reset times, and availability to:

```text
$XDG_STATE_HOME/agents-statusline/foreign-usage.json
```

The cache is mode `0600` and contains no provider credentials.

## Optional standalone bridge

The repository also contains a separate, unpatched launch path:

```bash
bin/claude-with-models
```

It starts `src/server.mjs` on a random loopback port, launches the installed
`codex app-server`, translates Anthropic-format text conversations into Codex
turns, proxies ordinary Claude requests to Anthropic, and can expose Kimi Code
when an official API key is stored through `bin/set-kimi-code-key`.

This bridge is not the `claude-all` path. It does not use CLIProxyAPI, the
patched runtime, per-model context overrides, or the swarm plugin. Codex turns
run read-only because Codex's approval UI cannot be represented safely through
Claude Code. It translates text responses, not arbitrary provider-native tool
protocols.

## Security boundaries

- Both gateway paths bind to loopback interfaces; do not expose them publicly.
- This repository contains no provider credentials and has no runtime npm
  dependencies.
- `claude-all` reads only its local CLIProxyAPI client key and passes it as the
  gateway authorization token.
- Context metadata is accepted only through a strict schema and only for
  explicitly route-validated models.
- Binary patching is exact and version-locked. It never scans loosely and
  patches the nearest-looking code.
- The stock `claude` command and stock binary are not modified. The patched
  runtime lives under `~/.local/share/claude-all` and updates are disabled.
- Provider authentication and upstream request handling belong to CLIProxyAPI;
  review that service independently.

## Repository layout

```text
bin/
  claude-all                     primary launcher
  claude-stable                  pinned stock-runtime launcher
  patch-claude-all-contexts      analyze, build, verify, and promote runtime
  verify-claude-all-runtime      fail-closed launch-time verification
  prepare-claude-context-env     validate context map and emit environment
  claude-all-usage               refresh sanitized provider-usage cache
  claude-with-models             optional standalone Codex/Kimi bridge launcher

src/
  claude-context-analyzer.mjs    known-build fingerprints and validation
  claude-context-patcher.mjs     exact binary replacements and attribution map
  context-map.mjs                context-map schema and environment generation
  server.mjs                     optional standalone bridge
  anthropic.mjs                  Anthropic/Codex message conversion helpers
  codex-client.mjs               Codex app-server client

plugin/
  commands/swarm.md              bounded native-team swarm command

config/
  claude-all-contexts.example.json

test/
  binary analyzer, patcher, protocol conversion, and context-map tests
```

`CLAUDE_CODE_CONTEXT_PATCH_PLAN.md` records the threat model and maintenance
procedure for adding support for a new Claude Code build.
