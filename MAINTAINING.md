# Maintaining All Models Patch

## Trust boundaries

There are three independent artifacts:

1. Anthropic's Stable pointer and stock binary.
2. An immutable support pack for one exact platform/version/hash tuple.
3. A project release manifest signed by the maintainer's pinned Ed25519 key.

Never publish or activate a pack based only on a version string, byte offset,
or semantic resemblance. Consumers receive exact recipes only; candidate
analysis remains a maintainer operation.

## Stable candidate workflow

1. Read `https://downloads.claude.ai/claude-code-releases/stable`.
2. Download the candidate manifest and `darwin-arm64` binary directly from
   Anthropic.
3. Verify manifest size/SHA-256, ARM64 Mach-O architecture, strict Apple code
   signature, Anthropic PBC authority, and team `Q6L2SF6YDW`.
4. Run the analyzer for every seam independently. A renamed minified function
   is review evidence, never patch authorization.
5. Extract the complete attribution, gateway-filter, gateway-bootstrap,
   context-resolver, compaction-resolver, and any version-specific feature
   regions. Review callers and adjacent control flow.
6. Create length-preserving replacements and prove every original occurs once.
7. Generate the support pack, then verify its deterministic unsigned output
   hash against a fresh stock download.
8. Ad-hoc sign the patched candidate, run `--version`, and exercise discovery,
   model switching, context reporting, compaction, attribution, streaming,
   tools, and child agents through the companion proxy.
9. Regenerate the signed catalog only after all checks pass.

Current reviewed layouts are recorded in `src/claude-context-analyzer.mjs`.
Version-specific recipe construction belongs in a dedicated reviewed module;
the generated JSON under `support/` is the consumer artifact.

## Support-pack invariants

Every pack must contain:

- schema and patch-engine versions;
- exact Claude version, platform, architecture, stock size, and stock SHA-256;
- exact original and replacement strings with one expected match;
- the feature group and dependency assigned to every recipe;
- a deterministic unsigned SHA-256 for every permitted feature combination;
- analysis offsets and resolver call counts;
- the deterministic unsigned patched SHA-256;
- Anthropic's expected Apple team identifier.

Published pack files are immutable. A new recipe revision gets a new
`patcher-N` support-pack ID and file; the previous pack remains byte-for-byte
unchanged and is marked `revoked` in a new higher release sequence. Do not edit
or delete the old pack.

Feature work is forward-only: generate new recipe revisions for the current
reviewed Stable build. Do not retrofit a new feature across older packs merely
for behavioral parity. Older packs may remain in the catalog for rollback, with
the behavior they originally shipped.

## Shipped model configuration

`config/claude-all-agents.json` and `config/claude-all-contexts.json` are the
first-install defaults included in every release. Keep them credential-free and
usable with the current companion gateway model IDs. Every named agent must map
to an active context profile, and context limits must come from a provider or
route source that can be rechecked.

The installer provisions only missing files under `~/.cli-proxy-api` with mode
`0600`; upgrades must never overwrite, merge, or normalize an existing user
file. When the default roster changes, update both configs together, run the
model-config tests, and describe only the resulting current setup in user docs.

Selectable packs default to `All`. Generation must enumerate every dependency-
valid profile (currently 24), reproduce each profile from stock, and verify
that disabled recipes retain their exact original bytes. Never accept a runtime
hash computed from an unlisted combination. Consumer upgrades preserve the
existing feature config; historical schema-1 packs remain fixed all-or-nothing
artifacts.

## Experimental agent-team preference

Claude Code's native agent-team switch is a launcher preference, not a patch
feature. Keep `agent-teams.json` separate from `FEATURE_GROUPS`, support-pack
profile keys, and deterministic patched hashes. Missing preference data means
disabled; malformed, unreadable, or unsupported present data must fail closed
before the Claude runtime starts.

The shell launcher must obtain the environment assignment from the compiled
manager and explicitly remove an inherited
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` value when disabled. Do not add a Node or
Bun runtime dependency to `claude-all`. Disabling native teams must not unload
the swarm plugin or named-agent bundle.

Normal first installs prompt with No as the default, while non-interactive
installs also default to disabled. Self-update must neither prompt for nor write
the preference. Reinstalls preserve a configured choice unless an explicit
`--agent-teams` or `--no-agent-teams` option is supplied.

## Release sequence

1. Bump `package.json` and increment `support/catalog.json.releaseSequence`.
2. Run the test and support-generation gates:

   ```bash
   npm test
   npm run check
   npm run support:generate
   ```

3. Confirm that Keychain Access contains the project `Developer ID Application`
   identity and that the `all-models-patch-notary` keychain profile is valid.
   Commit the scoped source changes, then run `npm run release:prepare`. Release
   preparation refuses dirty or uncommitted trees, signs the compiled manager
   with the hardened runtime and a trusted timestamp, verifies Apple team
   `5LTMYWRTYR`, and records the full source commit in the SSH-signed manifest.
4. Verify the generated manifest and archive:

   ```bash
   node bin/verify-release-artifacts
   ```

5. Test the archive on a clean Apple Silicon user account without Node. Confirm
   that both model configs are provisioned on first install, existing configs
   survive a reinstall byte-for-byte, and `claude-all` exports the shipped
   context overrides. Accept the default No for native agent teams and verify the
   environment variable is absent, then opt in and verify it appears only in a
   newly launched session. Exercise `--self-update` and confirm the preference
   bytes and modification time remain unchanged.
6. Run `bin/publish-release` to create the signed tag and GitHub release. It
   rebuilds, signs, verifies, and notarizes the artifacts from the still-clean
   current commit immediately before publication; pre-existing `dist` files are
   never trusted. Publication stops unless Apple returns `Accepted` and its
   detailed log contains an issue-free ARM64 ticket matching the manager's exact
   signed code-directory hash.

Create the notarization keychain profile once with an app-specific password:

```bash
xcrun notarytool store-credentials all-models-patch-notary \
  --apple-id "APPLE_ACCOUNT_EMAIL" \
  --team-id 5LTMYWRTYR
```

`ALL_MODELS_PATCH_CODESIGN_IDENTITY` and `ALL_MODELS_PATCH_NOTARY_PROFILE`
override the default certificate name and keychain profile for controlled
release environments. Do not put the app-specific password in this repository
or a release script.

The release manifest uses the SSH signing namespace
`all-models-patch-release`. Consumers store the highest accepted sequence and
reject older signed manifests to prevent replay.

The Apple Developer ID signature covers the project-authored manager only. The
patched Claude executable is derived and ad-hoc signed on each consumer's Mac;
it is never signed with the project's Developer ID or included in a release.

## Rollback and revocation testing

Before publication, test all of these transitions:

- new supported Stable build installs and promotes;
- unsupported Stable build leaves the active runtime unchanged;
- Stable rollback reactivates a cached runtime;
- uncached rollback reconstructs the exact older runtime;
- revoked inactive pack is ignored;
- revoked active pack falls back to the newest installed non-revoked runtime;
- no safe fallback causes `claude-all` to fail closed;
- interrupted stock download, patch, signing, smoke test, and symlink promotion
  leave the previous runtime usable.

Retain the active runtime and the two newest non-revoked rollback versions on
consumer machines. All older supported versions remain reconstructable from
Anthropic's release store and the immutable pack portfolio.
