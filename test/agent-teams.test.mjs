import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  agentTeamsEnvironment,
  effectiveAgentTeamsConfig,
  readAgentTeamsConfig,
  writeAgentTeamsConfig,
} from "../src/agent-teams.mjs";

function temporaryPath() {
  return join(mkdtempSync(join(tmpdir(), "all-models-agent-teams-")), "config", "agent-teams.json");
}

test("defaults missing agent teams configuration to disabled", () => {
  const config = effectiveAgentTeamsConfig(temporaryPath());
  assert.equal(config.source, "default");
  assert.equal(config.enabled, false);
  assert.deepEqual(agentTeamsEnvironment(config), []);
});

test("persists canonical agent teams choices with private permissions", () => {
  const path = temporaryPath();
  writeAgentTeamsConfig(path, true);
  assert.deepEqual(readAgentTeamsConfig(path), { schemaVersion: 1, enabled: true });
  assert.equal(readFileSync(path, "utf8"), '{\n  "schemaVersion": 1,\n  "enabled": true\n}\n');
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(agentTeamsEnvironment(effectiveAgentTeamsConfig(path)), ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"]);

  writeAgentTeamsConfig(path, false);
  assert.equal(readAgentTeamsConfig(path).enabled, false);
  assert.deepEqual(agentTeamsEnvironment(effectiveAgentTeamsConfig(path)), []);
});

test("rejects invalid agent teams configuration", () => {
  const path = temporaryPath();
  mkdirSync(dirname(path), { recursive: true });

  writeFileSync(path, "not json");
  assert.throws(() => readAgentTeamsConfig(path), /Unexpected token|Unexpected end/);

  writeFileSync(path, JSON.stringify({ schemaVersion: 2, enabled: true }));
  assert.throws(() => readAgentTeamsConfig(path), /unsupported agent teams config schema/);

  writeFileSync(path, JSON.stringify({ schemaVersion: 1, enabled: "yes" }));
  assert.throws(() => readAgentTeamsConfig(path), /enabled must be a boolean/);

  chmodSync(path, 0o600);
  assert.throws(() => writeAgentTeamsConfig(path, "yes"), /enabled must be a boolean/);
});
