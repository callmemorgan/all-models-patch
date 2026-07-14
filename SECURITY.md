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

## Reporting vulnerabilities

Please report vulnerabilities privately through GitHub's private vulnerability
reporting for `callmemorgan/all-models-patch`. Do not open a public issue for a
release-signing, updater, patch-validation, credential, or code-execution flaw.

Useful reports include the affected manager version, Claude version and hash,
support-pack ID, reproduction steps, and whether the issue occurs before or
after local patching. Never attach gateway credentials, OAuth tokens, prompts,
or private repository content.
