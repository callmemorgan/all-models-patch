# Repository guidance

`all-models-patch` maintains a fail-closed, locally applied Claude Code binary
patch for Apple Silicon macOS. Read `README.md`, `MAINTAINING.md`, and
`SECURITY.md` before changing updater, release, or patch logic.

## Invariants

- Never modify or redistribute Anthropic's stock executable.
- Never authorize a build by version, offset, or semantic resemblance alone.
- Consumer activation requires an exact active support pack matching platform,
  version, stock size, and stock SHA-256.
- Published support packs are immutable. Revoke them through a higher signed
  catalog sequence.
- Keep stock, patched, and manager releases versioned and promote only through
  atomic symlink replacement.
- Consumer runtime commands must not require Node, npm, Bun, GnuPG, or GitHub
  CLI.
- Shipped model configs must be credential-free, internally consistent, and
  provisioned only when the corresponding user file is absent.
- Do not weaken release signature, Apple signature, hash, architecture,
  match-count, code-signing, or smoke-test checks to make an update pass.

## Verification

Run these before committing patch or updater changes:

```bash
npm test
npm run check
git diff --check
```

Regenerate support packs only from the exact versioned stock binaries. Release
assets require `npm run release:prepare` and manual verification of the SSH
signature and clean-machine archive.

Keep unrelated plugin edits out of patch-maintenance commits and release
archives. The release builder intentionally takes plugin content from `HEAD`.
