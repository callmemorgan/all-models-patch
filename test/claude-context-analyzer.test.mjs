import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeClaudeBinary, inspectClaudeCandidate } from "../src/claude-context-analyzer.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.197/claude`;

test("recognizes the verified stock stable resolver", () => {
  const result = analyzeClaudeBinary(stable, { version: "2.1.197" });
  assert.equal(result.architecture, "arm64");
  assert.equal(result.attributionOffset, 213451965);
  assert.equal(result.gatewayFilterOffset, 204861577);
  assert.equal(result.contextCallCount, 18);
  assert.equal(result.compactCallCount, 13);
});

test("recognizes the reviewed Claude 2.1.201 resolver layout", () => {
  const path = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.201/claude`;
  const result = analyzeClaudeBinary(path, { version: "2.1.201" });
  assert.equal(result.architecture, "arm64");
  assert.equal(result.attributionOffset, 215740843);
  assert.equal(result.gatewayFilterOffset, 210059611);
  assert.equal(result.contextCallCount, 20);
  assert.equal(result.compactCallCount, 14);
});

test("rejects a changed resolver neighborhood", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-context-analyzer-"));
  const target = join(directory, "claude");
  const binary = readFileSync(stable);
  const offset = binary.indexOf("function rb(e,t)");
  binary[offset] = "F".charCodeAt(0);
  writeFileSync(target, binary);
  assert.throws(() => analyzeClaudeBinary(target), /fingerprint not found/);
});

test("reports candidate seams independently without authorizing an unknown hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-candidate-analyzer-"));
  const target = join(directory, "claude");
  const binary = readFileSync(stable);
  binary[100] ^= 1;
  writeFileSync(target, binary);
  const result = inspectClaudeCandidate(target);
  assert.equal(result.status, "review-required");
  assert.equal(result.version, null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.seams).map(([name, seam]) => [name, seam.status])),
    {
      attribution: "semantic-review",
      gatewayFilter: "semantic-review",
      contextResolver: "semantic-review",
      compactResolver: "semantic-review",
    },
  );
});
