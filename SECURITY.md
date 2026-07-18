# Security Policy

## Release verification

Project release manifests are signed with the Ed25519 key whose fingerprint is:

```text
SHA256:yLJtSegpLNiWyJYHeHI3MwP4qez0n+CF+K/EOHos6KY
```

The signing identity is `callmemorgan` and the SSH signature namespace is
`all-models-patch-release`. Consumer updates reject signatures from any other
identity, namespace, or key, and reject release-sequence rollback.

Stock Claude Code binaries must match Anthropic's manifest and Apple Developer
ID team `Q6L2SF6YDW`. Project releases never contain an Anthropic executable.

The project-authored `all-models-patch` manager must carry a hardened,
timestamped Developer ID Application signature from Apple team `5LTMYWRTYR`,
and publication requires an accepted Apple notarization submission. The
installer preserves and re-verifies that signature. Locally patched Claude
binaries remain ad-hoc signed because they are generated on the consumer's Mac.

## Local model configuration

The shipped agent and context JSON files contain model metadata only—never API
keys, OAuth tokens, account identifiers, prompts from user sessions, or private
paths. First-install provisioning creates them under `~/.cli-proxy-api` with
mode `0600`. Existing files are preserved rather than overwritten because they
may contain user-specific routing policy.

Gateway credentials remain outside the release. Do not include `client-key` or
provider credential JSON files in an issue, diagnostic bundle, release archive,
or model-config contribution.

## Reporting vulnerabilities

Please report vulnerabilities privately through GitHub's private vulnerability
reporting for `callmemorgan/all-models-patch`. Do not open a public issue for a
release-signing, updater, patch-validation, credential, or code-execution flaw.

Useful reports include the affected manager version, Claude version and hash,
support-pack ID, reproduction steps, and whether the issue occurs before or
after local patching. Never attach gateway credentials, OAuth tokens, prompts,
or private repository content.
