import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContextEnvironment } from "./context-map.mjs";
import { maybeSelfUpdate } from "./self-update.mjs";
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
const command = args.find((arg) => !arg.startsWith("--")) ?? "status";
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
  } else if (command === "doctor") {
    const { path, catalog } = loadSupportCatalog(toolRoot);
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
