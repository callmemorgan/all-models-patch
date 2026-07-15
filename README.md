# All Models Patch

`all-models-patch` runs Claude Code against real model IDs from multiple
providers through a local Anthropic-compatible gateway. It patches a verified
copy of Claude Code locally so that non-Anthropic models remain visible, use
route-specific context limits, compact at the right threshold, and receive
truthful Git attribution.

The normal command is:

```bash
claude-all
```

The project is an Apple Silicon macOS public preview. It does not redistribute
Claude Code. Every stock executable is downloaded directly from Anthropic,
verified, patched on the consumer's machine, ad-hoc signed locally, and kept
separate from the normal `claude` installation.

## Companion gateway

The supported gateway is
[`callmemorgan/CLIProxyAPI`](https://github.com/callmemorgan/CLIProxyAPI). The
two projects form a matched stack:

- `all-models-patch` owns Claude Code discovery, context, compaction,
  attribution, runtime verification, and updates.
- The CLIProxyAPI fork owns provider authentication, routing, real model IDs,
  response identity, and subscription-usage diagnostics.

The updater warns when the companion gateway cannot be reached but does not
block an otherwise valid runtime installation.

## Requirements

- Apple Silicon Mac (`darwin-arm64`)
- macOS `codesign`, `ssh-keygen`, `tar`, and `launchctl`
- the companion CLIProxyAPI fork listening on `http://127.0.0.1:8317`
- local gateway configuration at:

  ```text
  ~/.cli-proxy-api/client-key
  ~/.cli-proxy-api/claude-all-agents.json
  ~/.cli-proxy-api/claude-all-contexts.json
  ```

Consumers do not need Node, Bun, npm, GnuPG, the GitHub CLI, or a repository
checkout.

## Install a release

Download these assets from the
[latest GitHub release](https://github.com/callmemorgan/all-models-patch/releases/latest):

```text
all-models-patch-VERSION-darwin-arm64.tar.gz
release-manifest.json
release-manifest.json.sig
release-signers
```

Verify the release manifest with the built-in OpenSSH verifier:

```bash
expected='SHA256:yLJtSegpLNiWyJYHeHI3MwP4qez0n+CF+K/EOHos6KY'
actual="$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^ssh-(ed25519|rsa)$/) { print $i, $(i + 1); exit } }' release-signers \
  | ssh-keygen -lf - -E sha256 \
  | awk '{ print $2 }')"
test "$actual" = "$expected" || {
  echo "release signing key fingerprint mismatch" >&2
  exit 1
}

ssh-keygen -Y verify \
  -f release-signers \
  -I callmemorgan \
  -n all-models-patch-release \
  -s release-manifest.json.sig \
  < release-manifest.json
```

The pinned signing-key fingerprint used above is:

```text
SHA256:yLJtSegpLNiWyJYHeHI3MwP4qez0n+CF+K/EOHos6KY
```

Do not proceed unless both the explicit fingerprint comparison and signature
verification succeed. Compare the archive's `shasum -a 256` and byte size with
`release-manifest.json`, then extract and install it:

```bash
tar -xzf all-models-patch-VERSION-darwin-arm64.tar.gz
zsh all-models-patch-VERSION/bin/install-all-models-patch
```

The manager is signed with the project's Apple Developer ID Application
certificate and notarized by Apple. The installer preserves that signature and
verifies Apple team `5LTMYWRTYR` before it executes the manager. The independent
SSH signature still authenticates the complete release manifest, source commit,
archive hash, and release sequence. The installer never uses `sudo`.

The installer creates:

```text
~/.local/bin/all-models-patch
~/.local/bin/claude-all
~/.local/bin/claude-stable
~/.local/share/all-models-patch/releases/<manager-version>/
~/Library/LaunchAgents/com.callmemorgan.all-models-patch.stable-monitor.plist
```

On first install it offers **All** (recommended) or **Some**, then performs the
first Stable reconciliation. Pressing Enter once selects **All**, as does a
non-interactive install. Choosing **Some** opens a Y/n choice for each feature.
Existing selections are preserved on upgrades.

## Feature selection

The patch is split into five independently selectable groups:

| Feature | Benefit | Trade-off |
| --- | --- | --- |
| `discovery` | Shows real foreign-model IDs from the gateway | Changes Claude Code's native Anthropic-only filtering |
| `pricing` | Reports curated list-equivalent costs | Requires `discovery`; estimates public list prices rather than subscription billing |
| `context` | Uses route-specific context and compaction limits | Gateway metadata can override Claude Code's native model defaults |
| `attribution` | Credits the active model in generated commits | Changes generated commit trailers |
| `set-goal` | Exposes the native goal runtime to the model | Gives the model an additional autonomous planning tool |

The default profile is **All**. To inspect or change it later:

```bash
all-models-patch features
all-models-patch configure
all-models-patch configure --all
all-models-patch configure --only discovery,context
all-models-patch configure --none
```

Changing the selection rebuilds and re-verifies the current runtime. Pricing
cannot be selected without discovery. The current forward-only support pack
contains an exact deterministic hash for every permitted combination (24
profiles); arbitrary or incomplete combinations fail closed. Historical
rollback packs retain the fixed feature set they originally shipped with.

## Stable updates

Anthropic's Stable channel and this project's reviewed support catalog are two
separate authorities:

```text
Anthropic Stable changes
        |
        v
maintainer reviews exact binary seams
        |
        v
signed support pack is published
        |
        v
consumer downloads from Anthropic and patches locally
```

The daily LaunchAgent checks both sources. For an unknown Claude build it keeps
the existing runtime and reports `unsupported`; consumers never run heuristic
binary analysis. When an exact signed support pack becomes available, the
manager automatically:

1. verifies the signed, monotonic project release;
2. self-updates through a staged atomic switch when necessary;
3. downloads Claude Code directly from Anthropic;
4. verifies manifest size and SHA-256, ARM64 architecture, and Apple Developer
   ID team `Q6L2SF6YDW`;
5. applies every selected reviewed replacement exactly once;
6. verifies the deterministic unsigned hash authorized for that feature profile;
7. ad-hoc signs and smoke-tests the locally generated patched Claude result;
8. atomically promotes it while retaining verified rollback versions.

Stable rollbacks follow the same rules. A cached supported version is
reactivated; an uncached version is reconstructed from its retained support
pack; an unsupported or revoked version is never guessed.

Feature support is forward-only. New patch behavior is added to the current
reviewed Stable build and is not retrofitted into older support packs. Historical
packs may remain available for operational rollback, but retain the exact
feature set they originally shipped with. The manager keeps the active
last-known-good runtime until a reviewed successor is ready.

Useful commands:

```bash
all-models-patch status
all-models-patch status --json
all-models-patch check
all-models-patch update
all-models-patch features
all-models-patch configure
all-models-patch doctor
all-models-patch rollback 2.1.197
all-models-patch uninstall --yes
```

## Supported Claude builds

The signed portfolio currently contains exact Apple Silicon support for:

| Claude Code | Stock SHA-256 |
| --- | --- |
| `2.1.197` | `8cc0c4d1e4eb1dca3b0cc92ab02ee3505de764e023f8c901761c167b72041fb8` |
| `2.1.201` | `a0852d76afc47b30f5cb0b7625ec9a7714cb189f2eeef6c28c77e2be954fb7fd` |
| `2.1.202` | `7414f707861e2fe5afef33a466f888a8d2170e5028f5e9d2858f1d3ef45ffca5` |

Support is keyed by version, platform, and binary hash. A republished binary
with the same version but a different hash is unsupported until reviewed. The
table describes the rollback portfolio, not a promise that every historical
build receives features introduced later.

## What the patch changes

| Area | Patched behavior |
| --- | --- |
| Gateway discovery | Retain every model returned by the configured gateway |
| List-equivalent pricing | Load the gateway's curated model costs through Claude Code's native bootstrap cache |
| Context windows | Read validated per-model context limits from the launch environment |
| Compaction | Read validated per-model compaction thresholds |
| Git attribution | Credit the active model and identify this harness |
| Autonomous goals | Expose Claude Code's native goal runtime as the model-callable `set_goal` tool |

Generated commit attribution looks like:

```text
Generated-With: @callmemorgan/all-models-patch
Co-Authored-By: gpt-5.6-sol <noreply@openai.com>
```

Setting Claude Code's `attribution.commit` still overrides the generated block,
and setting `includeCoAuthoredBy` to `false` disables it.

## Runtime isolation

The stock and patched runtimes are versioned independently:

```text
~/.local/share/claude-stable/versions/<claude-version>/claude
~/.local/share/claude-all/versions/<claude-version>/claude
```

Each patched manifest references its exact versioned stock binary rather than
the mutable Stable symlink. An interrupted update therefore cannot invalidate
the previously active `claude-all` runtime.

`claude-all` uses an isolated `~/.claude-all` profile and always exports
`DISABLE_UPDATES=1`; the project manager, not Claude Code's built-in updater,
owns this runtime portfolio. The ordinary `claude` installation remains stock.

Uninstall removes the manager, its feature selection, LaunchAgent, and isolated
stock/patched runtime portfolios. It intentionally preserves `~/.claude-all`, `~/.cli-proxy-api`,
the companion proxy, and the ordinary stock `claude` installation.

## Development

Maintainers need Node 20 or newer and Bun for standalone release builds:

```bash
npm test
npm run check
npm run support:generate
npm run release:prepare
```

See [MAINTAINING.md](MAINTAINING.md) for candidate analysis, support-pack
review, revocation, signing, and publication. The exact `set_goal` seams and
verification contract are documented in [docs/SET_GOAL_PATCH.md](docs/SET_GOAL_PATCH.md).
See [SECURITY.md](SECURITY.md) for the trust and disclosure model.

## License

The patch tooling is available under the [MIT License](LICENSE). Claude Code is
downloaded separately from Anthropic and remains subject to Anthropic's terms.
