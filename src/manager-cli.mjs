import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadContextEnvironment } from "./context-map.mjs";
import { ALL_FEATURE_IDS, FEATURE_GROUPS, effectiveFeatureConfig, featureReport, readFeatureConfig, writeFeatureConfig } from "./features.mjs";
import { maybeSelfUpdate } from "./self-update.mjs";
import { provisionModelConfigs, validateShippedModelConfigs } from "./model-configs.mjs";
import {
  activateSupportedVersion,
  briefStatus,
  formatStatus,
  loadSupportCatalog,
  managerPaths,
  pinnedStockVersion,
  readManagerState,
  reconcileStable,
  resolveVerifiedRuntime,
  uninstallAllModelsPatch,
} from "./stable-manager.mjs";

const args = process.argv.slice(2);
const command = args[0]?.startsWith("--") ? "status" : (args[0] ?? "status");
const json = args.includes("--json");
const quiet = args.includes("--quiet");
const brief = args.includes("--brief");
const toolRoot = resolveToolRoot();
const paths = managerPaths();

try {
  if (command === "check" || command === "update") {
    if (!args.includes("--no-self-update")) {
      const catalog = loadSupportCatalog(toolRoot).catalog;
      const selfUpdate = await maybeSelfUpdate({
        toolRoot,
        currentVersion: catalog.managerVersion,
        currentSequence: catalog.releaseSequence,
        paths,
      });
      if (selfUpdate.updated) {
        const nextArgs = [command, "--no-self-update", ...args.filter((arg) => arg.startsWith("--") && arg !== "--no-self-update")];
        execFileSync(selfUpdate.executable, nextArgs, { stdio: "inherit" });
        process.exit(0);
      }
    }
    const state = await reconcileStable({ toolRoot, paths, quiet: quiet || json });
    if (json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else if (command === "status") {
    const state = readManagerState(paths);
    if (!state) {
      if (json) process.stdout.write("null\n");
      else if (!brief) process.stdout.write("No Stable check has completed yet. Run: all-models-patch check\n");
    } else if (brief) {
      const warning = briefStatus(state, pinnedStockVersion(paths));
      if (warning) process.stdout.write(`${warning}\n`);
    } else if (json) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else process.stdout.write(`${formatStatus(state)}\n`);
  } else if (command === "features") {
    const report = featureReport(effectiveFeatureConfig(paths.featureConfigPath));
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${formatFeatures(report)}\n`);
  } else if (command === "configure") {
    const existing = readFeatureConfig(paths.featureConfigPath);
    if (args.includes("--if-unset") && existing) {
      if (!quiet) process.stdout.write("Feature selection already configured; preserving it.\n");
    } else {
      const enabled = await requestedFeatures(args, existing?.enabled ?? ALL_FEATURE_IDS);
      const report = featureReport(writeFeatureConfig(paths.featureConfigPath, enabled));
      if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else if (!quiet) process.stdout.write(`${formatFeatures(report)}\n`);
      if (!args.includes("--no-update")) await reconcileStable({ toolRoot, paths, quiet: quiet || json });
    }
  } else if (command === "doctor") {
    const { path, catalog } = loadSupportCatalog(toolRoot);
    validateShippedModelConfigs(toolRoot);
    const report = {
      status: "ok",
      toolRoot,
      catalog: path,
      managerVersion: catalog.managerVersion,
      releaseSequence: catalog.releaseSequence,
      supportPacks: catalog.packs.length,
      platform: `${process.platform}-${process.arch}`,
      pinnedVersion: pinnedStockVersion(paths),
    };
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("only Apple Silicon macOS is supported");
    process.stdout.write(`${json ? JSON.stringify(report, null, 2) : Object.entries(report).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`);
  } else if (command === "runtime-path") {
    process.stdout.write(resolveVerifiedRuntime({ toolRoot, paths }));
  } else if (command === "provision-model-configs") {
    const result = provisionModelConfigs({ toolRoot, home: paths.home });
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (!quiet) {
      for (const path of result.installed) process.stdout.write(`Installed default model config: ${path}\n`);
      for (const path of result.preserved) process.stdout.write(`Preserved existing model config: ${path}\n`);
    }
  } else if (command === "context-env") {
    const index = args.indexOf("context-env");
    const path = args[index + 1];
    if (!path) throw new Error("usage: all-models-patch context-env CONTEXT-MAP.json");
    const { environment, warnings } = loadContextEnvironment(path);
    for (const warning of warnings) console.error(`claude-all: ${warning}`);
    process.stdout.write(`CLAUDE_ALL_CONTEXT_PATCH=1\n${environment.map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
  } else if (command === "rollback") {
    const index = args.indexOf("rollback");
    const version = args[index + 1];
    if (!version) throw new Error("usage: all-models-patch rollback VERSION");
    const result = await activateSupportedVersion(version, { toolRoot, paths });
    process.stdout.write(`${json ? JSON.stringify(result, null, 2) : `activated Claude ${version}: ${result.status}`}\n`);
  } else if (command === "uninstall") {
    if (!args.includes("--yes")) throw new Error("uninstall requires --yes; profiles and gateway credentials are preserved");
    uninstallAllModelsPatch({ paths });
    process.stdout.write("Removed all-models-patch manager and runtime portfolios. Profiles and gateway credentials were preserved.\n");
  } else {
    throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`all-models-patch: ${error.message}`);
  process.exitCode = 1;
}

function resolveToolRoot() {
  if (process.env.ALL_MODELS_PATCH_HOME) return resolve(process.env.ALL_MODELS_PATCH_HOME);
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(resolve(sourceRoot, "support", "catalog.json"))) return sourceRoot;
  const executable = realpathSync(process.execPath);
  const installedRoot = resolve(dirname(executable), "..");
  if (existsSync(resolve(installedRoot, "support", "catalog.json"))) return installedRoot;
  throw new Error("could not locate the installed support catalog");
}

async function requestedFeatures(argv, current) {
  if (argv.includes("--all")) return [...ALL_FEATURE_IDS];
  if (argv.includes("--none")) return [];
  let enabled = new Set(current);
  const only = optionValue(argv, "--only");
  if (only !== null) enabled = new Set(parseFeatureList(only));
  for (const id of parseFeatureList(optionValue(argv, "--enable") ?? "")) enabled.add(id);
  for (const id of parseFeatureList(optionValue(argv, "--disable") ?? "")) enabled.delete(id);
  if (only !== null || argv.includes("--enable") || argv.includes("--disable")) return [...enabled];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return [...ALL_FEATURE_IDS];

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultProfile = current.length === ALL_FEATURE_IDS.length ? "all" : "some";
    process.stdout.write("Choose a patch profile:\n\n  All   Enable every feature (recommended)\n  Some  Choose features individually\n\n");
    const profile = await askProfile(readline, defaultProfile);
    if (profile === "all") return [...ALL_FEATURE_IDS];

    process.stdout.write("\nChoose individual features. Press Enter to keep each current setting.\n\n");
    enabled = new Set();
    for (const feature of FEATURE_GROUPS) {
      if (feature.requires.some((requirement) => !enabled.has(requirement))) {
        process.stdout.write(`${feature.name}: disabled (requires ${feature.requires.join(", ")})\n`);
        continue;
      }
      const defaultEnabled = current.includes(feature.id);
      const answer = (await readline.question(`${feature.name} — ${feature.description}? [${defaultEnabled ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
      if (answer === "" ? defaultEnabled : answer === "y" || answer === "yes") enabled.add(feature.id);
    }
  } finally {
    readline.close();
  }
  return [...enabled];
}

async function askProfile(readline, defaultProfile) {
  while (true) {
    const label = defaultProfile === "all" ? "All" : "Some";
    const answer = (await readline.question(`Profile: All or Some? [${label}] `)).trim().toLowerCase();
    if (answer === "") return defaultProfile;
    if (answer === "a" || answer === "all") return "all";
    if (answer === "s" || answer === "some") return "some";
    process.stdout.write("Enter All or Some.\n");
  }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a comma-separated feature list`);
  return value;
}

function parseFeatureList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function formatFeatures(report) {
  const lines = [`Profile: ${report.profile === "all" ? "All" : "Custom"}`];
  for (const feature of report.features) lines.push(`${feature.enabled ? "yes" : "no "}  ${feature.id} — ${feature.name}`);
  return lines.join("\n");
}
