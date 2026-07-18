import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "claude-all");

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "claude-all-launcher-"));
  const proxyDirectory = join(home, ".cli-proxy-api");
  const localBin = join(home, ".local", "bin");
  const capture = join(home, "runtime.txt");
  const runtime = join(home, "fake-runtime");
  const manager = join(localBin, "all-models-patch");
  mkdirSync(proxyDirectory, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(proxyDirectory, "client-key"), "secret\n");
  writeFileSync(join(proxyDirectory, "claude-all-agents.json"), '{"test":{"description":"test","prompt":"test","model":"test"}}\n');
  writeFileSync(join(proxyDirectory, "claude-all-contexts.json"), '{}\n');
  writeFileSync(runtime, `#!/bin/zsh\nprint -r -- "teams=\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS-__UNSET__}" > "$CAPTURE_FILE"\nprint -r -- "context=\${TEST_CONTEXT-__UNSET__}" >> "$CAPTURE_FILE"\nprintf 'arg=%s\\n' "$@" >> "$CAPTURE_FILE"\n`);
  chmodSync(runtime, 0o755);
  writeFileSync(manager, `#!/bin/zsh\ncase "$1" in\n  status) exit 0 ;;\n  runtime-path) print -r -- "$FAKE_RUNTIME" ;;\n  context-env) print -r -- "TEST_CONTEXT=ok" ;;\n  agent-teams-env)\n    case "$FAKE_AGENT_TEAMS_MODE" in\n      enabled) print -r -- "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" ;;\n      disabled) exit 0 ;;\n      fail) print -u2 "invalid preference"; exit 9 ;;\n    esac\n    ;;\n  *) exit 2 ;;\nesac\n`);
  chmodSync(manager, 0o755);
  return { home, capture, runtime };
}

function run(state, mode, inheritedTeams) {
  const env = {
    ...process.env,
    HOME: state.home,
    ALL_MODELS_PATCH_HOME: repoRoot,
    FAKE_RUNTIME: state.runtime,
    FAKE_AGENT_TEAMS_MODE: mode,
    CAPTURE_FILE: state.capture,
  };
  if (inheritedTeams === undefined) delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  else env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = inheritedTeams;
  return spawnSync("/bin/zsh", [launcher, "--example"], { encoding: "utf8", env });
}

test("launcher passes enabled agent teams and existing launch data", () => {
  const state = fixture();
  const result = run(state, "enabled");
  assert.equal(result.status, 0, result.stderr);
  const capture = readFileSync(state.capture, "utf8");
  assert.match(capture, /^teams=1$/m);
  assert.match(capture, /^context=ok$/m);
  assert.match(capture, /^arg=--plugin-dir$/m);
  assert.match(capture, /^arg=--agents$/m);
  assert.match(capture, /^arg=--example$/m);
});

test("launcher removes an inherited agent teams value when disabled", () => {
  const state = fixture();
  const result = run(state, "disabled", "1");
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(state.capture, "utf8"), /^teams=__UNSET__$/m);
});

test("launcher stops before runtime execution when preference lookup fails", () => {
  const state = fixture();
  const result = run(state, "fail");
  assert.equal(result.status, 9);
  assert.match(result.stderr, /invalid preference/);
  assert.equal(existsSync(state.capture), false);
});
