import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertMonotonicRelease,
  RELEASE_SIGNING_NAMESPACE,
  validateReleaseManifest,
  verifyReleaseManifestSignature,
} from "../src/release-manifest.mjs";

function manifest(sequence = 7) {
  return {
    schemaVersion: 1,
    releaseSequence: sequence,
    managerVersion: "0.2.0",
    assets: {
      bundle: { name: "bundle.tar.gz", sha256: "a".repeat(64), size: 123 },
    },
  };
}

test("rejects replayed signed release sequences", () => {
  assertMonotonicRelease(manifest(7), 7);
  assert.throws(() => assertMonotonicRelease(manifest(6), 7), /replay detected/);
  assert.throws(() => validateReleaseManifest({ ...manifest(), managerVersion: "latest" }), /x.y.z/);
});

test("verifies the pinned SSH release signature protocol", () => {
  const directory = mkdtempSync(join(tmpdir(), "all-models-patch-signature-"));
  const key = join(directory, "signing-key");
  const path = join(directory, "release-manifest.json");
  const allowed = join(directory, "allowed-signers");
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  writeFileSync(allowed, `callmemorgan namespaces=\"${RELEASE_SIGNING_NAMESPACE}\" ${publicKey}\n`);
  writeFileSync(path, `${JSON.stringify(manifest(), null, 2)}\n`);
  execFileSync("/usr/bin/ssh-keygen", ["-Y", "sign", "-f", key, "-n", RELEASE_SIGNING_NAMESPACE, path]);
  assert.equal(
    verifyReleaseManifestSignature({ manifestPath: path, signaturePath: `${path}.sig`, allowedSignersPath: allowed }).releaseSequence,
    7,
  );
  writeFileSync(path, `${JSON.stringify(manifest(8), null, 2)}\n`);
  assert.throws(
    () => verifyReleaseManifestSignature({ manifestPath: path, signaturePath: `${path}.sig`, allowedSignersPath: allowed }),
    /Command failed/,
  );
});
