# Claude Code Per-Model Context Patch Plan

## Objective

Give the private `claude-all` harness accurate, per-model context-window accounting while keeping the normal `claude` installation stock. Claude Code should display the correct percentage, compact at a safe model-specific threshold, and pass long conversations to CLIProxyAPI without prematurely treating every gateway model as 200K.

This is a maintained binary compatibility patch, not a claim that a client-side number enlarges any provider's real context window. Every configured limit must be supported by the upstream provider path actually used by CLIProxyAPI.

## Current State (2026-07-11)

- macOS arm64; Claude Code `2.1.207` is installed as a 230 MB Mach-O at `~/.local/share/claude/versions/2.1.207`, with `~/.local/bin/claude` symlinked to it.
- The Mach-O contains bundled/minified JavaScript in recoverable plaintext. It contains the strings `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `contextWindow`, and `contextWindowSize`.
- `claude-all` is a separate launcher at `~/.local/bin/claude-all`. It points Claude Code at CLIProxyAPI on `127.0.0.1:8317`, loads a private API key, enables gateway discovery, and injects a private named-agent bundle.
- CLIProxyAPI `7.2.65` runs as a Homebrew login service. Anthropic, Codex/OpenAI, xAI, Kimi, and Antigravity OAuth credentials are installed under `~/.cli-proxy-api` with user-only permissions.
- The adapter's `/v1/models` output supplies model IDs and ownership but no context-window metadata. Claude Code's gateway discovery documents consumption of `id` and optional `display_name`, not a context-size field.
- Claude Code therefore treats unknown gateway models as 200K. The installed binary supports a process-wide `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, but that cannot accurately describe multiple models in one process.
- The `claude-all`-only named agents currently select GPT-5.6 Sol/Terra/Luna, Grok 4.5, Kimi K2.7 Code, Gemini 3.5 Flash Low, and Grok Composer 2.5 Fast. A Sol parent dispatching a Terra child has been verified end to end.
- The existing source files in this repository predate the active CLIProxyAPI setup and describe a different local bridge. Do not silently merge the two architectures during this work.

## Required Behavior

1. Resolve a context profile from the exact effective model ID for every main-agent and subagent request.
2. Use that profile consistently for:
   - context-window display and status-line percentage;
   - auto-compaction threshold calculations;
   - model usage metadata reported in `--output-format json`;
   - any preflight “prompt too long” checks.
3. Fall back to Claude Code's stock resolver for model IDs absent from the private map.
4. Never raise an unknown model above the stock default.
5. Keep direct `claude` byte-for-byte stock and independently updatable.
6. Fail closed after Claude Code updates: if the expected patch target changes, `claude-all` must refuse to use an unverified patched runtime rather than guessing.

## Context Profile Source

Store the private model map outside the patched executable, for example at `~/.cli-proxy-api/claude-all-contexts.json`, and pass its path through a new private environment variable such as `CLAUDE_ALL_CONTEXT_MAP`. The patched resolver reads and validates this file once at startup.

Proposed schema:

```json
{
  "schemaVersion": 1,
  "models": {
    "gpt-5.6-sol": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" },
    "gpt-5.6-terra": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" },
    "gpt-5.6-luna": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" },
    "grok-4.5": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" },
    "kimi-k2.7-code": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" },
    "gemini-3.5-flash-low": { "contextTokens": 1048576, "compactAtTokens": 950000, "status": "provider-documented" },
    "grok-composer-2.5-fast": { "contextTokens": null, "compactAtTokens": null, "status": "unverified" }
  }
}
```

Do not fill unknown values from memory or marketing pages. `null` means use stock behavior. Gemini's documented native input limit is 1,048,576, but its Antigravity route must still be load-tested before the map is enabled at that value. The compaction threshold must reserve enough room for the system prompt, tool definitions, tool results, reasoning overhead, and maximum useful response; it must not simply equal the provider limit.

Aliases and variants must be explicit entries. Do not use broad prefix matching unless tests prove that every matching model has the same upstream limit. Normalize only Claude Code decorations known to be client-side, such as a validated `[1m]` suffix; do not normalize provider version identifiers into one bucket.

## Patch Architecture

### Isolation

- Copy the stock executable for the active version to `~/.local/share/claude-all/versions/<version>/claude`.
- Record the stock binary SHA-256, patched binary SHA-256, Claude version, patcher version, matched code fingerprint, timestamp, and context-map schema in a manifest beside it.
- Ad-hoc sign only the copied binary. Never modify `~/.local/share/claude/versions/*` or retarget `~/.local/bin/claude`.
- Update `claude-all` to execute the verified patched copy. Keep all existing proxy/auth/agent-bundle environment setup.

### Locating the Resolver

Build a read-only analysis command first. It must:

1. Confirm architecture, version, and stock hash.
2. Locate all occurrences of the existing context environment-variable strings.
3. Extract a bounded source neighborhood around each occurrence from the embedded bundle.
4. Identify the single resolver that computes the effective context limit from model identity and the process-wide overrides.
5. Produce a stable semantic fingerprint using multiple adjacent literals and control-flow features, not a byte offset alone.

Offsets are version-specific and must never be the only guard. The analyzer must reject zero matches, multiple plausible matches, truncated source, or unexpected surrounding code.

### Patch Method

Prefer a structure-preserving bundle rewrite over blind in-place replacement:

- Determine how the Bun/standalone payload is embedded and whether it can be extracted, modified, and rebuilt reproducibly with the same runtime version.
- If a reproducible rebuild is not possible, use a length-preserving binary patch only when the target JavaScript region has adequate replaceable space and the entire original byte sequence is uniquely matched.
- Never shift Mach-O load-command offsets or overwrite unrelated bytes.
- Patch one narrow seam: before the stock context resolver returns its result, consult the validated private map using the effective model ID. If no verified entry exists, execute the original logic unchanged.
- Avoid patching every caller independently; divergent display and compaction logic would be worse than the current 200K fallback.

The injected code must not perform network access, log prompts, read provider credentials, or accept executable configuration. It may read only the declared JSON map. Invalid JSON, invalid schema, non-integer values, values outside a conservative range, or `compactAtTokens >= contextTokens` must cause that entry to be ignored with a concise local warning.

### Signing and Verification

- Remove any copied stock signature only as required, then sign the copied artifact with `codesign --force --sign -`.
- Run `codesign --verify --deep --strict` and verify the Mach-O architecture after signing.
- Confirm the stock binary hash still matches the pre-patch manifest.
- The launcher must validate the patched artifact and manifest before execution. A missing/mismatched manifest falls back to an explicit error with instructions to rerun the patcher; it must not silently launch a stale or half-patched binary.

## Update Workflow

Create a dedicated command such as `bin/patch-claude-all-contexts` with these modes:

- `analyze`: inspect the current stock Claude Code version and print whether the known patch strategy matches; make no changes.
- `build`: copy, patch, sign, manifest, and test a new isolated runtime.
- `verify`: re-run hashes, signature checks, resolver smoke tests, and launcher checks.
- `clean`: remove only obsolete patched versions that are not active; never touch stock Claude versions or credentials.

On each Claude Code update:

1. Let the ordinary Claude updater finish normally.
2. Run `analyze` against the newly selected stock version.
3. If the semantic fingerprint changed, stop and manually inspect the new resolver.
4. Build into a new versioned directory; never overwrite the last working patched version.
5. Run the complete test matrix.
6. Atomically update the `claude-all` runtime pointer only after all tests pass.
7. Retain one previous verified patched runtime for rollback.

Do not automate patching immediately on update. A background auto-patcher would turn upstream code changes into unreviewed executable modification.

## Provider-Limit Validation

Before enabling a non-null context value:

1. Find an official provider specification for the exact upstream model family and record the URL and retrieval date.
2. Confirm CLIProxyAPI maps the client-visible ID to that exact backend rather than a smaller compatibility deployment.
3. Generate synthetic, non-sensitive input near stepped boundaries without placing repository or credential content in the payload.
4. Probe below and above the proposed limit through the same Claude Messages route used by `claude-all`.
5. Verify streaming, tool use, and multi-turn thought/signature preservation at a practical large size.
6. Choose `compactAtTokens` below the smallest consistently accepted boundary with an explicit safety reserve.

Testing large contexts can consume substantial subscription quota or usage credits. Add a dry-run token estimator and require an explicit flag for paid/load tests. Never perform boundary tests against Anthropic `claude -p` under the assumption that it is included subscription usage; current Anthropic policy treats that surface separately.

## Test Plan

### Static and Safety Tests

- Stock SHA matches the manifest input and remains unchanged after patching.
- Exactly one resolver fingerprint matches.
- Patched binary is arm64, executable, and passes strict code-sign verification.
- Invalid/missing map, unknown schema, duplicate keys, fractional/negative/oversized values, and unsafe compaction thresholds all fall back safely.
- `claude --version` continues to run from the stock binary; `claude-all --version` runs from the patched copy.
- Direct `claude` does not load CLIProxy credentials, private agents, or context-map variables.

### Resolver Unit Fixtures

Build a small extracted resolver test harness or equivalent deterministic fixture tests:

- mapped exact model returns its configured context and compaction threshold;
- unmapped model returns stock 200K behavior;
- configured Claude `[1m]` behavior remains stock-compatible;
- parent and named child with different model IDs resolve independently;
- model switching during a session refreshes the effective profile rather than retaining the first model's value;
- resume restores the selected model and recomputes the profile from the current map.

### End-to-End Tests

- Launch `claude-all` on a 350K-profile model and verify JSON `modelUsage.contextWindow`, status-line percentage, and compaction diagnostics use the configured value.
- Dispatch two named subagents with different profiles and verify each reports its own context window.
- Run enough synthetic context to cross 200K without premature compaction on a verified larger model.
- Approach the configured compaction threshold and verify compaction occurs before the provider rejects the request.
- Switch to an unmapped/200K model in the same session and verify it compacts safely at stock behavior.
- Verify tool calls, streaming, images where supported, and child-agent dispatch still work through CLIProxyAPI.
- Restart CLIProxyAPI and Claude Code; confirm behavior persists without stale gateway-model cache effects.

### Negative and Rollback Tests

- Deliberately alter the stock binary hash: patcher refuses.
- Deliberately alter the expected resolver bytes: patcher refuses without writing an executable.
- Corrupt the patched binary or manifest: launcher refuses and prints the exact recovery command.
- Roll back the `claude-all` runtime pointer to the previous verified version and confirm normal operation.

## Acceptance Criteria

- Normal `claude` remains stock and works independently of CLIProxyAPI and the patch.
- `claude-all` uses a separately signed, versioned, verified executable.
- Context display, compaction, preflight checks, and JSON usage metadata agree for every mapped model.
- Different parent/subagent models in one process use different configured limits.
- Unknown or unverified models retain safe stock behavior.
- Upstream over-limit errors are not observed below the selected compaction thresholds in validation tests.
- A Claude Code update cannot silently activate an unverified patch.
- The full patch can be removed by repointing/deleting only `claude-all` assets; no stock installation repair is required.

## Explicit Non-Goals

- Do not bypass provider authentication, quota, billing, safety, or server-enforced context limits.
- Do not disguise third-party traffic as first-party traffic.
- Do not modify CLIProxyAPI's provider routing or OAuth credentials as part of this patch.
- Do not make the old repository bridge and the active CLIProxyAPI service coexist automatically.
- Do not enable guessed context sizes merely to improve the status-line display.
- Do not patch the direct Claude Code executable in place.

## Recommended Implementation Order

1. Freeze and document the current `claude-all` launcher/config/agent bundle hashes for rollback.
2. Implement the read-only analyzer and capture the 2.1.207 resolver neighborhood and semantic fingerprint.
3. Determine whether the embedded bundle can be rebuilt; choose the safest viable patch technique and document the decision.
4. Implement isolated copy, guarded patch, manifest, ad-hoc signing, and verification.
5. Add the external context-map parser with all values initially `null` except separately validated entries.
6. Add resolver fixtures and stock-versus-patched launcher tests.
7. Validate provider limits one model at a time, starting with Gemini 3.5 Flash because its official 1M specification is known.
8. Run mixed parent/subagent end-to-end tests.
9. Switch `claude-all` atomically to the patched runtime and retain the previous launcher/runtime for rollback.
10. Document the manual procedure required after each Claude Code update.

## Open Research Items Before Coding the Patch

- Locate every call site of the context resolver and confirm a single seam covers display, compaction, request preflight, and usage reporting.
- Determine whether subagent workers share the same loaded module state and whether model switches invalidate cached context metadata.
- Establish official and route-verified context limits for GPT-5.6 Sol/Terra/Luna, Grok 4.5, Kimi K2.7 Code, and Grok Composer 2.5 Fast.
- Verify whether Antigravity preserves Gemini 3.5 Flash's full 1M input limit through CLIProxyAPI.
- Determine the minimum safe output/reserved-token margin per provider and whether reasoning tokens consume the advertised input or combined window differently.
- Test whether Claude Code's `[1m]` suffix can provide a supported per-model path for Gemini without a binary patch; keep it as a fallback if it behaves correctly for named subagents.

No implementation should begin by changing numeric constants. The first deliverable is a read-only, version-aware analyzer that proves exactly which resolver is being changed and why.
