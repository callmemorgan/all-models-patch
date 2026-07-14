import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertMonotonicRelease, verifyReleaseManifestSignature } from "./release-manifest.mjs";
import { downloadAtomic, managerPaths, readManagerState, writeManagerState } from "./stable-manager.mjs";

export const DEFAULT_RELEASE_BASE = "https://github.com/callmemorgan/all-models-patch/releases/latest/download";

export function isInstalledToolRoot(toolRoot, home = process.env.HOME) {
  return Boolean(home && toolRoot.startsWith(join(home, ".local", "share", "all-models-patch", "releases")));
}

export async function maybeSelfUpdate({
  toolRoot,
  currentVersion,
  currentSequence,
  paths = managerPaths(),
  fetchImpl = fetch,
  releaseBase = process.env.ALL_MODELS_PATCH_RELEASE_BASE ?? DEFAULT_RELEASE_BASE,
  force = false,
  verifyManifest = verifyReleaseManifestSignature,
} = {}) {
  if (!force && !isInstalledToolRoot(toolRoot)) return { updated: false, skipped: "development checkout" };
  const lockPath = join(paths.stateDirectory, ".release-update.lock");
  acquireReleaseLock(lockPath);
  try {
  const checkDirectory = join(paths.stateDirectory, "release-check");
  mkdirSync(checkDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = join(checkDirectory, "release-manifest.json");
  const signaturePath = join(checkDirectory, "release-manifest.json.sig");
  writeFileSync(manifestPath, await fetchBuffer(`${releaseBase}/release-manifest.json`, fetchImpl), { mode: 0o600 });
  writeFileSync(signaturePath, await fetchBuffer(`${releaseBase}/release-manifest.json.sig`, fetchImpl), { mode: 0o600 });
  const manifest = verifyManifest({
    manifestPath,
    signaturePath,
    allowedSignersPath: join(toolRoot, "config", "release-signers"),
  });
  const previous = readManagerState(paths);
  const releaseFloor = acceptedReleaseFloor(previous, currentSequence);
  assertMonotonicRelease(manifest, releaseFloor);
  if (manifest.managerVersion === currentVersion) {
    if (currentSequence !== undefined && manifest.releaseSequence !== currentSequence) {
      throw new Error("signed release sequence changed without a manager version change");
    }
  } else if (currentSequence !== undefined && manifest.releaseSequence === currentSequence) {
    throw new Error("signed manager version changed without a release sequence change");
  }
  recordAcceptedReleaseSequence(paths, manifest.releaseSequence);
  if (manifest.managerVersion === currentVersion) {
    return { updated: false, manifest };
  }

  const bundle = manifest.assets.bundle;
  const archive = join(checkDirectory, bundle.name);
  await downloadAtomic(`${releaseBase}/${bundle.name}`, archive, {
    expectedSize: bundle.size,
    expectedSha256: bundle.sha256,
    fetchImpl,
  });
  const extractRoot = join(checkDirectory, `extract-${process.pid}`);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
  try {
    const entries = execFileSync("/usr/bin/tar", ["-tzf", archive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    if (entries.length === 0 || entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) {
      throw new Error("release bundle contains an unsafe archive path");
    }
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", extractRoot], { stdio: "pipe" });
    const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (roots.length !== 1) throw new Error("release bundle must contain exactly one root directory");
    const releaseRoot = join(extractRoot, roots[0].name);
    const installer = join(releaseRoot, "bin", "install-all-models-patch");
    if (!existsSync(installer) || statSync(installer).size === 0) throw new Error("release bundle has no installer");
    const installEnvironment = { ...process.env, HOME: paths.home };
    const stagedManager = join(releaseRoot, "bin", "all-models-patch");
    const stagedReport = JSON.parse(execFileSync(stagedManager, ["doctor", "--json"], {
      encoding: "utf8",
      env: { ...installEnvironment, ALL_MODELS_PATCH_HOME: releaseRoot },
    }));
    if (stagedReport.managerVersion !== manifest.managerVersion || stagedReport.releaseSequence !== manifest.releaseSequence) {
      throw new Error("release bundle does not match the signed release manifest");
    }
    execFileSync("/bin/zsh", [installer, "--self-update"], { env: installEnvironment, stdio: "inherit" });
    const installed = join(paths.home, ".local", "bin", "all-models-patch");
    const report = JSON.parse(execFileSync(installed, ["doctor", "--json"], { encoding: "utf8", env: installEnvironment }));
    if (report.managerVersion !== manifest.managerVersion || report.releaseSequence !== manifest.releaseSequence) {
      throw new Error("installed manager does not match the signed release manifest");
    }
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
  return {
    updated: true,
    manifest,
    executable: join(paths.home, ".local", "bin", "all-models-patch"),
  };
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function acceptedReleaseFloor(previous, currentSequence) {
  const persisted = previous?.highestAcceptedReleaseSequence ?? 0;
  for (const [label, value] of [["persisted", persisted], ["installed", currentSequence ?? 0]]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} release sequence is invalid`);
  }
  return Math.max(persisted, currentSequence ?? 0);
}

export function recordAcceptedReleaseSequence(paths, releaseSequence) {
  if (!Number.isSafeInteger(releaseSequence) || releaseSequence < 1) throw new Error("accepted release sequence is invalid");
  const previous = readManagerState(paths);
  const persisted = acceptedReleaseFloor(previous, 0);
  writeManagerState(paths, {
    ...(previous ?? {}),
    highestAcceptedReleaseSequence: Math.max(persisted, releaseSequence),
  });
}

async function fetchBuffer(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!response.ok) throw new Error(`release request failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function acquireReleaseLock(path) {
  mkdirSync(pathsafeDirectory(path), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      if (Date.now() - statSync(path).mtimeMs > 15 * 60 * 1_000) {
        rmSync(path, { recursive: true, force: true });
        return acquireReleaseLock(path);
      }
      throw new Error("another signed release update is already running");
    }
    throw error;
  }
}

function pathsafeDirectory(path) {
  return path.slice(0, path.lastIndexOf("/"));
}
