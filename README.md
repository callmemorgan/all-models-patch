# Claude Code Model Bridge

A personal, local model gateway for Claude Code. It makes the models available
to your existing Codex subscription appear in Claude Code's `/model` picker,
without using a third-party adapter or copying a ChatGPT/Codex token.

## What it does

- Binds only to `127.0.0.1`, on a fresh random port for each launch.
- Starts the locally installed `codex app-server`; that process performs its
  normal authentication using your existing Codex login. The bridge does not
  read `$CODEX_HOME/auth.json`, persist access tokens, or send credentials to
  any endpoint other than the selected provider's official endpoint.
- Queries the app server for the models your subscription actually exposes and
  publishes them to Claude Code as `Codex — …` entries in `/model`.
- Keeps ordinary Claude models available by passing their requests through to
  `api.anthropic.com` with the headers Claude Code supplied.
- Optionally adds Kimi Code if *you* create a Kimi Code API key. The helper
  stores that key in the macOS Keychain, not in this repo.

It deliberately does **not** reuse session cookies or OAuth refresh tokens
from Kimi CLI, Grok, Kiro, Antigravity, Ollama, or another tool. A paid
subscription is not a portable API credential unless its provider explicitly
offers that path.

## Use it

From the project you want Claude Code to work in:

```bash
/Users/morgan/personal/claude-code-model-bridge/bin/claude-with-models
```

Then run `/model` in Claude Code and select an entry named `Codex — …`. The
list is discovered from the current Codex login at startup, so it follows your
account's actual model availability.

To add Kimi Code after obtaining an official Kimi Code API key:

```bash
/Users/morgan/personal/claude-code-model-bridge/bin/set-kimi-code-key
```

Run the launcher again; `/model` will then also show `Kimi Code` and, when
supported by the key, `Kimi Code HighSpeed`.

### Subscription usage

Refresh the sanitized usage cache on demand with:

```bash
claude-all-usage
```

Use `--json`, `--cached`, or `--provider=codex,grok,agy,kimi` for scripting.
The command asks the loopback gateway to use its already-loaded credentials;
the cache contains only percentages, reset times, and availability state at
`$XDG_STATE_HOME/agents-statusline/foreign-usage.json` (mode `0600`).

The status-line segments `usage-codex`, `usage-grok`, `usage-agy`, and
`usage-kimi` display every window returned for their provider. The installed
`agents-statusline` also refreshes this cache on demand: when it is at least one
minute old, the next render starts one detached `claude-all-usage` process and
continues displaying stale data; the following render sees the atomic update.

### Ollama Cloud models

The local CLIProxyAPI configuration can route Ollama's OpenAI-compatible API at
`http://127.0.0.1:11434/v1`. The current roster exposes
`minimax-m3:cloud` as `minimax-m3` and `glm-5.2:cloud` as `glm-5.2`, with
matching `minimax-m3` and `glm-5-2` agent types. Ollama must be running and the
cloud manifests must be installed with `ollama pull` before those routes work.
The proxy entry uses the non-secret placeholder key `ollama-local`; Ollama
ignores its bearer value, but the installed proxy build requires a compatibility
credential entry to register the provider.

Context and compaction limits follow the Ollama manifests used by this route:
MiniMax M3 uses 524,288 tokens and compacts at 471,859; GLM-5.2 uses 1,000,000
tokens and compacts at 900,000. These values deliberately do not assume that a
provider's native API limit is available through Ollama.

### Swarm mode

`claude-all` uses its own Claude Code profile at `~/.claude-all` via
`CLAUDE_CONFIG_DIR`. Its settings, sessions, plugins, and local state therefore
stay separate from both stock `~/.claude` and `claude-personal`'s
`~/.claude-personal` profile.

`claude-all` enables Claude Code's native agent-team runtime and loads a private
`/claude-all-swarm:swarm <task>` command. The command performs a one-shot,
Kimi-inspired fan-out:
it partitions batch-friendly work, launches independent teammates concurrently,
waits for them, synthesizes their results, and shuts the team down.
It keeps at most five workers live by default and refills that bounded wave as
workers finish, avoiding an unbounded burst against subscription gateways.

```text
/claude-all-swarm:swarm Audit every service under services/ for missing auth checks. Do not edit files.
```

This intentionally uses Claude Code's local team primitives rather than
pretending to expose Kimi Code's `AgentSwarm` tool. Consequently it does not
inherit Kimi's exact 128-worker cap, ramp/backoff scheduler, or resume contract.
It also never switches the session into bypass-permissions mode automatically.

The namespace keeps the command exclusive to `claude-all`. Installing it as a
bare `/swarm` command would place it in the shared Claude configuration, where
the stock launcher would advertise a command whose agent-team runtime is not
enabled.

## Security model

The old third-party adapter and its plaintext OAuth token directory were
removed before this repo was created. This project has no npm dependencies,
does not include a telemetry client, and does not write provider credentials.

Codex turns run in `read-only` mode. That is intentional: Codex's native
approval UI cannot be securely represented through Claude Code yet, so the
bridge refuses approval requests rather than authorizing commands or edits in
the background. The selected Codex model can inspect the workspace and answer
questions, but it cannot change files through this first version.

The bridge receives the HTTP authorization header that Claude Code sends only
in memory to proxy ordinary Claude requests. It never logs request headers,
prompts, bodies, or provider responses. As with any loopback HTTP service, do
not run untrusted local software while it is active.

## Design boundary

This is a compatibility bridge, not a patch to Claude Code. The public
Anthropic Messages surface and Codex app-server have different tool protocols.
For a selected Codex model, the bridge converts the Claude conversation to a
Codex turn and streams back its text answer. It does not claim that Claude
Code's tool calls are natively translated or that Codex made a change when it
did not.

The generated `protocol/` schemas used during development are intentionally
ignored; regenerate them from the locally installed Codex CLI when updating
the app-server integration:

```bash
codex app-server generate-json-schema --out protocol
```
