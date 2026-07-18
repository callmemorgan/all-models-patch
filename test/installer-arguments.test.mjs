import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(repoRoot, "bin", "install-all-models-patch");

function run(args) {
  return spawnSync("/bin/zsh", [installer, ...args], { encoding: "utf8" });
}

test("installer rejects conflicting agent teams choices before installation", () => {
  const result = run(["--agent-teams", "--no-agent-teams"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mutually exclusive/);
});

test("installer rejects agent teams choices during self-update", () => {
  const result = run(["--self-update", "--no-agent-teams"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/);
});

test("installer rejects unknown arguments before installation", () => {
  const result = run(["--unknown"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: install-all-models-patch/);
});
