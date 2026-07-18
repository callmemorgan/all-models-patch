import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { compareVersions, fileSha256, resolveSupportPackProfile, selectSupportPack, validateSupportCatalog, validateSupportPack } from "./support-pack.mjs";
import { patchClaudeBinaryWithSupportPack, verifyPatchedBytesWithSupportPack } from "./claude-context-patcher.mjs";
import { effectiveFeatureConfig } from "./features.mjs";

export const MANAGER_STATE_SCHEMA = 1;
export const ANTHROPIC_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
export const EXPECTED_APPLE_TEAM = "Q6L2SF6YDW";

export function managerPaths(home = process.env.HOME, stateHome = process.env.XDG_STATE_HOME, configHome = process.env.XDG_CONFIG_HOME) {
  if (!home) throw new Error("HOME is not set");
  const stateRoot = stateHome || join(home, ".local", "state");
  const configRoot = configHome || join(home, ".config");
  return {
    home,
    stateDirectory: join(stateRoot, "all-models-patch"),
    statePath: join(stateRoot, "all-models-patch", "stable-update.json"),
    lockPath: join(stateRoot, "all-models-patch", ".stable-update.lock"),
    configDirectory: join(configRoot, "all-models-patch"),
    featureConfigPath: join(configRoot, "all-models-patch", "features.json"),
    agentTeamsConfigPath: join(configRoot, "all-models-patch", "agent-teams.json"),
    stockRoot: join(home, ".local", "share", "claude-stable"),
    patchedRoot: join(home, ".local", "share", "claude-all"),
    managerRoot: join(home, ".local", "share", "all-models-patch"),
    localBin: join(home, ".local", "bin"),
    launchAgentPath: join(home, "Library", "LaunchAgents", "com.callmemorgan.all-models-patch.stable-monitor.plist"),
  };
}

export function readManagerState(paths) {
  try {
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    if (state.schemaVersion !== MANAGER_STATE_SCHEMA) throw new Error(`unsupported state schema: ${state.schemaVersion}`);
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function writeManagerState(paths, state) {
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${paths.statePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: MANAGER_STATE_SCHEMA, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.statePath);
}

export function pinnedStockVersion(paths) {
  const current = join(paths.stockRoot, "current");
  if (!existsSync(current)) return null;
  const version = realpathSync(current).split("/").at(-1);
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

export async function fetchStableDescriptor({
  fetchImpl = fetch,
  releasesUrl = ANTHROPIC_RELEASES_URL,
  timeoutMs = 15_000,
} = {}) {
  const stableVersion = (await fetchText(`${releasesUrl}/stable`, { fetchImpl, timeoutMs })).trim();
  if (!/^\d+\.\d+\.\d+$/.test(stableVersion)) throw new Error(`Stable pointer returned invalid version: ${stableVersion}`);
  return fetchVersionDescriptor(stableVersion, { fetchImpl, releasesUrl, timeoutMs });
}

export async function fetchVersionDescriptor(version, {
  fetchImpl = fetch,
  releasesUrl = ANTHROPIC_RELEASES_URL,
  timeoutMs = 15_000,
} = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid Claude version: ${version}`);
  const manifest = JSON.parse(await fetchText(`${releasesUrl}/${version}/manifest.json`, { fetchImpl, timeoutMs }));
  const platform = manifest?.platforms?.["darwin-arm64"];
  if (!platform || typeof platform !== "object") throw new Error(`Claude ${version} manifest has no darwin-arm64 entry`);
  if (!Number.isSafeInteger(platform.size) || platform.size <= 0) throw new Error(`Claude ${version} manifest size is invalid`);
  if (typeof platform.checksum !== "string" || !/^[a-f0-9]{64}$/.test(platform.checksum)) {
    throw new Error(`Claude ${version} manifest checksum is invalid`);
  }
  return { stableVersion: version, manifest, platform };
}

export function loadSupportCatalog(toolRoot) {
  const path = join(toolRoot, "support", "catalog.json");
  return { path, catalog: validateSupportCatalog(JSON.parse(readFileSync(path, "utf8"))) };
}

export function loadSupportPack(toolRoot, entry) {
  const path = join(toolRoot, "support", entry.path);
  if (fileSha256(path) !== entry.packSha256) throw new Error(`support pack hash mismatch: ${entry.id}`);
  const pack = validateSupportPack(JSON.parse(readFileSync(path, "utf8")));
  if (pack.id !== entry.id || pack.stock.sha256 !== entry.stockSha256) throw new Error(`support pack identity mismatch: ${entry.id}`);
  return { path, pack };
}

export async function reconcileStable({
  toolRoot,
  paths = managerPaths(),
  fetchImpl = fetch,
  releasesUrl = ANTHROPIC_RELEASES_URL,
  notify = notifyUser,
  quiet = false,
} = {}) {
  if (!toolRoot) throw new Error("toolRoot is required");
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  acquireLock(paths.lockPath);
  const previous = readManagerState(paths);
  let installedCatalog = null;
  try {
    const checkedAt = new Date().toISOString();
    const pinnedVersion = pinnedStockVersion(paths);
    installedCatalog = loadSupportCatalog(toolRoot).catalog;
    const descriptor = await fetchStableDescriptor({ fetchImpl, releasesUrl });
    const catalog = installedCatalog;
    const entry = selectSupportPack(catalog, {
      claudeVersion: descriptor.stableVersion,
      platform: "darwin-arm64",
      stockSha256: descriptor.platform.checksum,
    });
    let result;

    if (entry?.status === "active") {
      const { pack } = loadSupportPack(toolRoot, entry);
      const features = effectiveFeatureConfig(paths.featureConfigPath);
      result = await installSupportedRuntime({ descriptor, entry, pack, catalog, paths, fetchImpl, releasesUrl, enabledFeatures: features.enabled });
      const proxyWarning = await probeCompanionProxy({ paths, fetchImpl });
      if (proxyWarning) result.proxyWarning = proxyWarning;
    } else {
      const revokedFallback = fallbackRevokedRuntime({ catalog, toolRoot, paths });
      if (revokedFallback) result = revokedFallback;
      else {
        result = {
          status: entry?.status === "revoked" ? "revoked" : "unsupported",
          detail: entry?.status === "revoked" ? "the exact support pack is revoked" : "maintainer review is required",
        };
      }
    }

    const state = {
      checkedAt,
      lastSuccessfulCheckAt: checkedAt,
      consecutiveFailures: 0,
      highestAcceptedReleaseSequence: Math.max(previous?.highestAcceptedReleaseSequence ?? 0, catalog.releaseSequence),
      managerVersion: catalog.managerVersion,
      stableVersion: descriptor.stableVersion,
      stableSha256: descriptor.platform.checksum,
      pinnedVersion: pinnedStockVersion(paths) ?? pinnedVersion,
      relation: versionRelation(descriptor.stableVersion, pinnedStockVersion(paths) ?? pinnedVersion),
      result,
      notifiedStableVersion: previous?.notifiedStableVersion ?? null,
    };
    if (previous?.stableVersion !== descriptor.stableVersion || previous?.result?.status !== result.status) {
      const body = notificationBody(state);
      if (notify("Claude Stable changed", body)) state.notifiedStableVersion = descriptor.stableVersion;
    }
    writeManagerState(paths, state);
    if (!quiet) process.stdout.write(`${formatStatus(state)}\n`);
    return state;
  } catch (error) {
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const state = {
      ...(previous ?? {}),
      checkedAt: new Date().toISOString(),
      consecutiveFailures: failures,
      highestAcceptedReleaseSequence: Math.max(
        previous?.highestAcceptedReleaseSequence ?? 0,
        installedCatalog?.releaseSequence ?? 0,
      ),
      lastError: error.message,
    };
    if (failures === 3) notify("All Models Patch monitor failed", `${failures} consecutive checks failed: ${error.message}`);
    writeManagerState(paths, state);
    throw error;
  } finally {
    rmSync(paths.lockPath, { recursive: true, force: true });
  }
}

export function fallbackRevokedRuntime({ catalog, toolRoot, paths = managerPaths() }) {
  const currentManifestPath = join(paths.patchedRoot, "current", "manifest.json");
  if (!existsSync(currentManifestPath)) return null;
  const currentManifest = JSON.parse(readFileSync(currentManifestPath, "utf8"));
  const currentEntry = catalog.packs.find((entry) => entry.id === currentManifest.supportPackId);
  if (!currentEntry || currentEntry.status !== "revoked") return null;

  const versionsRoot = join(paths.patchedRoot, "versions");
  const candidates = existsSync(versionsRoot)
    ? readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => compareVersions(right, left))
    : [];
  for (const version of candidates) {
    const directory = join(versionsRoot, version);
    const manifestPath = join(directory, "manifest.json");
    const patchedPath = join(directory, "claude");
    if (!existsSync(manifestPath) || !existsSync(patchedPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = catalog.packs.find((candidate) => candidate.id === manifest.supportPackId);
    if (!entry || entry.status !== "active") continue;
    try {
      const { pack } = loadSupportPack(toolRoot, entry);
      if (manifest.supportPackSha256 !== entry.packSha256) throw new Error("runtime manifest support-pack hash mismatch");
      verifyInstalledRuntime({ patchedPath, stockPath: manifest.stockPath, manifest, pack });
      promoteRuntime(paths.patchedRoot, directory);
      promoteRuntime(paths.stockRoot, dirname(manifest.stockPath));
      return {
        status: "revocation-fallback",
        detail: `revoked ${currentManifest.claudeVersion}; activated ${version}`,
        supportPackId: entry.id,
        patchedPath,
      };
    } catch {
      // Continue until a complete non-revoked runtime is found.
    }
  }
  return {
    status: "revoked-no-fallback",
    detail: `active support pack is revoked and no verified fallback is installed: ${currentManifest.supportPackId}`,
  };
}

export async function installSupportedRuntime({ descriptor, entry, pack, catalog, paths, fetchImpl, releasesUrl, enabledFeatures }) {
  const version = descriptor.stableVersion;
  const stockDirectory = join(paths.stockRoot, "versions", version);
  const stockPath = join(stockDirectory, "claude");
  const patchedDirectory = join(paths.patchedRoot, "versions", version);
  const patchedPath = join(patchedDirectory, "claude");
  const patchedManifestPath = join(patchedDirectory, "manifest.json");
  const profile = resolveSupportPackProfile(pack, enabledFeatures);

  if (existsSync(patchedPath) && existsSync(patchedManifestPath)) {
    const manifest = JSON.parse(readFileSync(patchedManifestPath, "utf8"));
    if (
      manifest.supportPackId === pack.id &&
      manifest.supportPackSha256 === entry.packSha256 &&
      manifest.stockSha256 === pack.stock.sha256 &&
      manifest.featureProfile === profile.key
    ) {
      verifyInstalledRuntime({ patchedPath, stockPath: manifest.stockPath, manifest, pack });
      promoteRuntime(paths.patchedRoot, patchedDirectory);
      if (existsSync(stockPath)) promoteRuntime(paths.stockRoot, stockDirectory);
      if (catalog) pruneRuntimeCache(paths, version, catalog);
      return { status: "activated-cached", supportPackId: entry.id, patchedPath, featureProfile: profile.key };
    }
  }

  mkdirSync(stockDirectory, { recursive: true, mode: 0o700 });
  if (!existsSync(stockPath) || fileSha256(stockPath) !== descriptor.platform.checksum) {
    await downloadAtomic(`${releasesUrl}/${version}/darwin-arm64/claude`, stockPath, {
      expectedSize: descriptor.platform.size,
      expectedSha256: descriptor.platform.checksum,
      fetchImpl,
    });
  }
  chmodSync(stockPath, 0o755);
  verifyAnthropicBinary(stockPath, descriptor.platform);

  mkdirSync(patchedDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(patchedDirectory, `.claude.tmp-${process.pid}`);
  rmSync(temporary, { force: true });
  try {
    const patch = patchClaudeBinaryWithSupportPack({ source: stockPath, target: temporary, supportPack: pack, enabledFeatures: profile.enabledFeatures });
    if (patch.unsignedPatchedSha256 !== profile.expectedUnsignedPatchedSha256) throw new Error("support pack output hash mismatch");
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", temporary], { stdio: "pipe" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", temporary], { stdio: "pipe" });
    execFileSync(temporary, ["--version"], { stdio: "pipe", env: { ...process.env, DISABLE_UPDATES: "1" } });
    renameSync(temporary, patchedPath);
    const manifest = {
      schemaVersion: 3,
      claudeVersion: version,
      platform: "darwin-arm64",
      supportPackId: pack.id,
      supportPackSha256: entry.packSha256,
      stockPath,
      stockSha256: pack.stock.sha256,
      patchedSha256: fileSha256(patchedPath),
      unsignedPatchedSha256: profile.expectedUnsignedPatchedSha256,
      featureProfile: profile.key,
      enabledFeatures: profile.enabledFeatures,
      builtAt: new Date().toISOString(),
    };
    writeFileSync(patchedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    verifyInstalledRuntime({ patchedPath, stockPath, manifest, pack });
    promoteRuntime(paths.patchedRoot, patchedDirectory);
    promoteRuntime(paths.stockRoot, stockDirectory);
    if (catalog) pruneRuntimeCache(paths, version, catalog);
    return { status: "installed", supportPackId: entry.id, patchedPath, featureProfile: profile.key };
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function activateSupportedVersion(version, {
  toolRoot,
  paths = managerPaths(),
  fetchImpl = fetch,
  releasesUrl = ANTHROPIC_RELEASES_URL,
} = {}) {
  const descriptor = await fetchVersionDescriptor(version, { fetchImpl, releasesUrl });
  const { catalog } = loadSupportCatalog(toolRoot);
  const entry = selectSupportPack(catalog, {
    claudeVersion: version,
    platform: "darwin-arm64",
    stockSha256: descriptor.platform.checksum,
  });
  if (!entry) throw new Error(`no support pack matches Claude ${version} (${descriptor.platform.checksum})`);
  if (entry.status !== "active") throw new Error(`support pack for Claude ${version} is ${entry.status}`);
  const { pack } = loadSupportPack(toolRoot, entry);
  const features = effectiveFeatureConfig(paths.featureConfigPath);
  return installSupportedRuntime({ descriptor, entry, pack, catalog, paths, fetchImpl, releasesUrl, enabledFeatures: features.enabled });
}

export function verifyInstalledRuntime({ patchedPath, stockPath, manifest, pack }) {
  const profile = resolveSupportPackProfile(pack, manifest.enabledFeatures);
  if (manifest.stockSha256 !== pack.stock.sha256) throw new Error("runtime manifest stock hash does not match its support pack");
  const manifestedProfile = manifest.featureProfile ?? (pack.schemaVersion === 1 ? "legacy-all" : null);
  if (manifestedProfile !== profile.key) throw new Error("runtime manifest feature profile does not match its support pack");
  if (manifest.unsignedPatchedSha256 !== profile.expectedUnsignedPatchedSha256) throw new Error("runtime manifest patched hash does not match its support pack");
  if (!existsSync(stockPath) || fileSha256(stockPath) !== manifest.stockSha256) throw new Error("versioned stock runtime no longer matches its manifest");
  if (fileSha256(patchedPath) !== manifest.patchedSha256) throw new Error("patched runtime hash mismatch");
  verifyPatchedBytesWithSupportPack(patchedPath, pack, { enabledFeatures: profile.enabledFeatures });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", patchedPath], { stdio: "pipe" });
}

export function resolveVerifiedRuntime({ toolRoot, paths = managerPaths() }) {
  const root = join(paths.patchedRoot, "current");
  const patchedPath = join(root, "claude");
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 3) throw new Error("the active runtime predates selectable features; run all-models-patch update");
  const { catalog } = loadSupportCatalog(toolRoot);
  const entry = catalog.packs.find((candidate) => candidate.id === manifest.supportPackId);
  if (!entry) throw new Error(`active support pack is not installed: ${manifest.supportPackId}`);
  if (entry.status !== "active") throw new Error(`active support pack is ${entry.status}: ${manifest.supportPackId}`);
  if (manifest.supportPackSha256 !== entry.packSha256) throw new Error("runtime manifest support-pack hash mismatch");
  const { pack } = loadSupportPack(toolRoot, entry);
  const configured = resolveSupportPackProfile(pack, effectiveFeatureConfig(paths.featureConfigPath).enabled);
  if (manifest.featureProfile !== configured.key) throw new Error("the feature selection changed; run all-models-patch update");
  verifyInstalledRuntime({ patchedPath, stockPath: manifest.stockPath, manifest, pack });
  return patchedPath;
}

export function uninstallAllModelsPatch({ paths = managerPaths(), unloadLaunchAgent = true } = {}) {
  if (unloadLaunchAgent && process.platform === "darwin" && typeof process.getuid === "function") {
    spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/com.callmemorgan.all-models-patch.stable-monitor`], { stdio: "ignore" });
  }
  for (const name of ["all-models-patch", "claude-all", "claude-stable"]) {
    const path = join(paths.localBin, name);
    try {
      if (lstatSync(path).isSymbolicLink() && readlinkSync(path).includes("all-models-patch")) rmSync(path, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  rmSync(paths.launchAgentPath, { force: true });
  rmSync(paths.managerRoot, { recursive: true, force: true });
  rmSync(paths.patchedRoot, { recursive: true, force: true });
  rmSync(paths.stockRoot, { recursive: true, force: true });
  rmSync(paths.stateDirectory, { recursive: true, force: true });
  rmSync(paths.configDirectory, { recursive: true, force: true });
}

export function verifyAnthropicBinary(path, platform) {
  if (statSync(path).size !== platform.size) throw new Error(`Anthropic binary size mismatch for ${path}`);
  if (fileSha256(path) !== platform.checksum) throw new Error(`Anthropic binary checksum mismatch for ${path}`);
  if (machoArchitecture(readFileSync(path)) !== "arm64") throw new Error("Anthropic binary is not arm64");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", path], { stdio: "pipe" });
  const detail = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", path], { encoding: "utf8" });
  if (detail.status !== 0) throw new Error(`could not inspect Anthropic code signature: ${detail.stderr.trim()}`);
  if (!detail.stderr.includes(`TeamIdentifier=${EXPECTED_APPLE_TEAM}`)) throw new Error("Anthropic binary has an unexpected Apple team identifier");
  if (!detail.stderr.includes("Authority=Developer ID Application: Anthropic PBC")) throw new Error("Anthropic binary is not signed by Anthropic PBC");
}

export async function downloadAtomic(url, target, { expectedSize, expectedSha256, fetchImpl = fetch, timeoutMs = 120_000 }) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.download-${process.pid}`;
  rmSync(temporary, { force: true });
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
    if (statSync(temporary).size !== expectedSize) throw new Error(`download size mismatch for ${url}`);
    if (fileSha256(temporary) !== expectedSha256) throw new Error(`download checksum mismatch for ${url}`);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function briefStatus(state, currentPinnedVersion = state?.pinnedVersion ?? null) {
  if (!state?.stableVersion || state.stableVersion === currentPinnedVersion) return "";
  const result = state.result?.status ?? "unknown";
  const direction = currentPinnedVersion && compareVersions(state.stableVersion, currentPinnedVersion) < 0 ? "rolled back to" : "is available at";
  return `claude-all: Claude Stable ${direction} ${state.stableVersion}; pinned ${currentPinnedVersion ?? "none"}; ${result}.`;
}

export function formatStatus(state) {
  const lines = [
    `Stable: ${state.stableVersion ?? "unknown"}`,
    `Pinned: ${state.pinnedVersion ?? "none"}`,
    `Result: ${state.result?.status ?? "unknown"}`,
  ];
  if (state.result?.detail) lines.push(`Detail: ${state.result.detail}`);
  if (state.result?.proxyWarning) lines.push(`Proxy warning: ${state.result.proxyWarning}`);
  if (state.lastSuccessfulCheckAt) lines.push(`Checked: ${state.lastSuccessfulCheckAt}`);
  if (state.lastError) lines.push(`Last error: ${state.lastError}`);
  return lines.join("\n");
}

export function notifyUser(title, body) {
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
  return result.status === 0;
}

export async function probeCompanionProxy({ paths = managerPaths(), fetchImpl = fetch, baseUrl = "http://127.0.0.1:8317" } = {}) {
  const keyPath = join(paths.home, ".cli-proxy-api", "client-key");
  if (!existsSync(keyPath)) return `companion proxy credential is missing: ${keyPath}`;
  try {
    const token = readFileSync(keyPath, "utf8").trim();
    const response = await fetchImpl(`${baseUrl}/v1/models?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return `companion proxy model discovery returned HTTP ${response.status}`;
    const body = await response.json();
    if (!Array.isArray(body?.data)) return "companion proxy model discovery returned an invalid response";
    return null;
  } catch (error) {
    return `companion proxy check failed: ${error.message}`;
  }
}

function promoteRuntime(root, directory) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const next = join(root, `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(directory, next);
  renameSync(next, join(root, "current"));
}

function pruneRuntimeCache(paths, activeVersion, catalog) {
  const patchedVersionsRoot = join(paths.patchedRoot, "versions");
  if (!existsSync(patchedVersionsRoot)) return;
  const activePackIds = new Set(catalog.packs.filter((entry) => entry.status === "active").map((entry) => entry.id));
  const safeVersions = readdirSync(patchedVersionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((version) => {
      try {
        const manifest = JSON.parse(readFileSync(join(patchedVersionsRoot, version, "manifest.json"), "utf8"));
        return activePackIds.has(manifest.supportPackId);
      } catch {
        return false;
      }
    })
    .sort((left, right) => compareVersions(right, left));
  const keep = new Set([activeVersion, ...safeVersions.filter((version) => version !== activeVersion).slice(0, 2)]);
  for (const root of [paths.stockRoot, paths.patchedRoot]) {
    const versionsRoot = join(root, "versions");
    if (!existsSync(versionsRoot)) continue;
    for (const entry of readdirSync(versionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && !keep.has(entry.name)) {
        rmSync(join(versionsRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function acquireLock(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      const ageMs = Date.now() - statSync(path).mtimeMs;
      if (ageMs > 15 * 60 * 1_000) {
        rmSync(path, { recursive: true, force: true });
        return acquireLock(path);
      }
      throw new Error("another Stable check is already running");
    }
    throw error;
  }
}

function versionRelation(stableVersion, pinnedVersion) {
  if (!pinnedVersion) return "uninstalled";
  const comparison = compareVersions(stableVersion, pinnedVersion);
  return comparison === 0 ? "current" : comparison > 0 ? "upgrade" : "rollback";
}

function notificationBody(state) {
  if (state.result.status === "installed" || state.result.status === "activated-cached") {
    return `Claude Stable ${state.stableVersion} was verified and activated.`;
  }
  return `Claude Stable ${state.stableVersion} is ${state.result.status}; continuing to use ${state.pinnedVersion ?? "no pinned runtime"}.`;
}

async function fetchText(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`request failed (${response.status}) for ${url}`);
  return response.text();
}

function machoArchitecture(binary) {
  if (binary.length < 8 || binary.readUInt32BE(0) !== 0xcffaedfe) return "not-mach-o-64";
  return binary.readUInt32LE(4) === 0x0100000c ? "arm64" : "unsupported";
}
