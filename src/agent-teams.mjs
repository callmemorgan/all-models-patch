import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const AGENT_TEAMS_CONFIG_SCHEMA = 1;
export const AGENT_TEAMS_ENV_NAME = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";

export function readAgentTeamsConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (config.schemaVersion !== AGENT_TEAMS_CONFIG_SCHEMA) {
      throw new Error(`unsupported agent teams config schema: ${config.schemaVersion}`);
    }
    if (typeof config.enabled !== "boolean") throw new Error("agent teams enabled must be a boolean");
    return Object.freeze({ schemaVersion: AGENT_TEAMS_CONFIG_SCHEMA, enabled: config.enabled });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function effectiveAgentTeamsConfig(path) {
  const configured = readAgentTeamsConfig(path);
  return Object.freeze({
    schemaVersion: AGENT_TEAMS_CONFIG_SCHEMA,
    source: configured ? "configured" : "default",
    enabled: configured?.enabled ?? false,
  });
}

export function writeAgentTeamsConfig(path, enabled) {
  if (typeof enabled !== "boolean") throw new Error("agent teams enabled must be a boolean");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: AGENT_TEAMS_CONFIG_SCHEMA, enabled }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return effectiveAgentTeamsConfig(path);
}

export function agentTeamsEnvironment(config) {
  return config.enabled ? [`${AGENT_TEAMS_ENV_NAME}=1`] : [];
}
