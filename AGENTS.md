# Repository guidance

`all-models-patch` maintains a fail-closed, locally applied Claude Code binary
patch for Apple Silicon macOS. Read `README.md`, `MAINTAINING.md`, and
`SECURITY.md` before changing updater, release, or patch logic.

## Support policy

- Feature development is forward-only. Add new recipes to the current reviewed
  Stable build; do not retrofit new features into older support packs.
- Older packs may remain available for operational rollback, but their behavior
  stays frozen. A rollback does not promise features introduced later.
- Keep the active last-known-good runtime until a successor has passed exact
  binary review and live verification.
- Never edit or delete a published support pack. New recipe revisions receive a
  new `patcher-N` identity; superseded packs remain immutable in the catalog.

## Invariants

- Never modify or redistribute Anthropic's stock executable.
- Never authorize a build by version, offset, or semantic resemblance alone.
- Consumer activation requires an exact active support pack matching platform,
  version, stock size, and stock SHA-256.
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
