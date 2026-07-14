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
5. Extract the complete attribution, gateway-filter, context-resolver, and
   compaction-resolver regions. Review callers and adjacent control flow.
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
- analysis offsets and resolver call counts;
- the deterministic unsigned patched SHA-256;
- Anthropic's expected Apple team identifier.

Published pack files are immutable. To withdraw one, mark its catalog entry
`revoked` in a new higher release sequence. Do not edit or delete the old pack.

## Release sequence

1. Bump `package.json` and increment `support/catalog.json.releaseSequence`.
2. Run the test and support-generation gates:

   ```bash
   npm test
   npm run check
   npm run support:generate
   ```

3. Commit the scoped source changes, then run `npm run release:prepare`. Release
   preparation refuses dirty or uncommitted trees and records the full source
   commit in the signed manifest.
4. Verify the generated manifest and archive:

   ```bash
   node bin/verify-release-artifacts
   ```

5. Test the archive on a clean Apple Silicon user account without Node.
6. Run `bin/publish-release` to create the signed tag and GitHub release. It
   rebuilds, signs, and verifies the artifacts from the still-clean current
   commit immediately before publication; pre-existing `dist` files are never
   trusted.

The release manifest uses the SSH signing namespace
`all-models-patch-release`. Consumers store the highest accepted sequence and
reject older signed manifests to prevent replay.

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
