import { constants, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadContextEnvironment } from "./context-map.mjs";

export const SHIPPED_MODEL_CONFIGS = Object.freeze([
  "claude-all-agents.json",
  "claude-all-contexts.json",
]);

export function provisionModelConfigs({ toolRoot, home = process.env.HOME } = {}) {
  if (!toolRoot) throw new Error("toolRoot is required");
  if (!home) throw new Error("HOME is not set");
  validateShippedModelConfigs(toolRoot);

  const destinationDirectory = join(home, ".cli-proxy-api");
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  chmodSync(destinationDirectory, 0o700);

  const installed = [];
  const preserved = [];
  for (const name of SHIPPED_MODEL_CONFIGS) {
    const source = join(toolRoot, "config", name);
    const destination = join(destinationDirectory, name);
    try {
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      installed.push(destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      preserved.push(destination);
    }
  }
  return { installed, preserved };
}

export function validateShippedModelConfigs(toolRoot) {
  const agentsPath = join(toolRoot, "config", "claude-all-agents.json");
  const contextsPath = join(toolRoot, "config", "claude-all-contexts.json");
  if (!existsSync(agentsPath) || !existsSync(contextsPath)) throw new Error("shipped model configs are incomplete");

  const agents = JSON.parse(readFileSync(agentsPath, "utf8"));
  if (!isPlainObject(agents) || Object.keys(agents).length === 0) throw new Error("shipped agent bundle must be a non-empty object");
  for (const [name, agent] of Object.entries(agents)) {
    if (!isPlainObject(agent) || typeof agent.model !== "string" || !agent.model || typeof agent.prompt !== "string" || !agent.prompt) {
      throw new Error(`invalid shipped agent profile: ${name}`);
    }
  }

  const contexts = JSON.parse(readFileSync(contextsPath, "utf8"));
  const { environment, warnings } = loadContextEnvironment(contextsPath);
  if (warnings.length > 0) throw new Error(`invalid shipped context map: ${warnings.join("; ")}`);
  const activeModels = new Set(environment.filter(([name]) => name.startsWith("CLAUDE_ALL_CONTEXT_")).map(([name]) => name.slice("CLAUDE_ALL_CONTEXT_".length)));
  for (const agent of Object.values(agents)) {
    if (!activeModels.has(agent.model)) throw new Error(`shipped agent model has no active context profile: ${agent.model}`);
  }
  if (contexts.models["kimi-k3"]?.contextTokens !== 1_000_000) throw new Error("shipped Kimi K3 context profile must use its 1M window");
  return { agentsPath, contextsPath };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
