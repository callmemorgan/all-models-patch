import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const RELEASE_MANIFEST_SCHEMA = 1;
export const RELEASE_SIGNING_IDENTITY = "callmemorgan";
export const RELEASE_SIGNING_NAMESPACE = "all-models-patch-release";

export function validateReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("release manifest must be an object");
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA) throw new Error(`unsupported release manifest schema: ${manifest.schemaVersion}`);
  if (!Number.isSafeInteger(manifest.releaseSequence) || manifest.releaseSequence < 1) throw new Error("release sequence must be positive");
  if (typeof manifest.managerVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.managerVersion)) {
    throw new Error("release managerVersion must use x.y.z syntax");
  }
  if (typeof manifest.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) {
    throw new Error("release sourceCommit must be a full Git commit ID");
  }
  if (!manifest.assets || typeof manifest.assets !== "object") throw new Error("release manifest assets are missing");
  validateAsset(manifest.assets.bundle, "bundle");
  return manifest;
}

export function verifyReleaseManifestSignature({ manifestPath, signaturePath, allowedSignersPath, exec = execFileSync }) {
  const manifest = readFileSync(manifestPath);
  exec(
    "/usr/bin/ssh-keygen",
    [
      "-Y",
      "verify",
      "-f",
      allowedSignersPath,
      "-I",
      RELEASE_SIGNING_IDENTITY,
      "-n",
      RELEASE_SIGNING_NAMESPACE,
      "-s",
      signaturePath,
    ],
    { input: manifest, stdio: ["pipe", "pipe", "pipe"] },
  );
  return validateReleaseManifest(JSON.parse(manifest.toString("utf8")));
}

export function assertMonotonicRelease(manifest, highestAcceptedSequence = 0) {
  validateReleaseManifest(manifest);
  if (manifest.releaseSequence < highestAcceptedSequence) {
    throw new Error(`release manifest replay detected: got sequence ${manifest.releaseSequence}, previously accepted ${highestAcceptedSequence}`);
  }
}

function validateAsset(asset, label) {
  if (!asset || typeof asset !== "object") throw new Error(`release ${label} asset is missing`);
  if (typeof asset.name !== "string" || asset.name.length === 0) throw new Error(`release ${label} asset name is missing`);
  if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`release ${label} asset SHA-256 is invalid`);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`release ${label} asset size is invalid`);
}
