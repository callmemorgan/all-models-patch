# Repository guidance

`all-models-patch` maintains a fail-closed, locally applied Claude Code binary
patch for Apple Silicon macOS. Read `README.md`, `MAINTAINING.md`, and
`SECURITY.md` before changing updater, release, or patch logic.

## Support policy

- Feature development is forward-only. Add new recipes to the current reviewed
  Stable build; do not retrofit new features into older support packs.
- Older packs may remain available for operational rollback, but their behavior
  stays frozen. A rollback does not promise features introduced later.
- Selectable features are forward-only too. Add profile metadata only in a new
  current-Stable support-pack revision; never retrofit historical packs.
- Consumer configuration defaults to `All`. Preserve an existing selection on
  upgrade, and treat dependency-invalid selections as errors rather than
  silently enabling or disabling another feature.
- Keep the active last-known-good runtime until a successor has passed exact
  binary review and live verification.
- Ship credential-free default agent and context configs together. Provision
  only missing user files; never overwrite an existing routing configuration.
- Never edit or delete a published support pack. New recipe revisions receive a
  new `patcher-N` identity; superseded packs remain immutable in the catalog.

## Invariants

- Never modify or redistribute Anthropic's stock executable.
- Never authorize a build by version, offset, or semantic resemblance alone.
- Consumer activation requires an exact active support pack matching platform,
  version, stock size, and stock SHA-256.
- Every permitted selectable-feature combination must have its own reviewed
  deterministic output hash in the support pack. Disabled recipes must remain
  byte-for-byte stock and are verified as such.
- Keep stock, patched, and manager releases versioned and promote only through
  atomic symlink replacement.
- Do not weaken release signature, Apple signature, hash, architecture,
  match-count, code-signing, or smoke-test checks to make an update pass.

## Verification

Run these before committing patch or updater changes:

```bash
npm test
npm run check
npm run support:generate
git diff --check
```

Support generation targets the current reviewed Stable build only. Historical
pack files are inputs to the signed portfolio, not regeneration targets.
