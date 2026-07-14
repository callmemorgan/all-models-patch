import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeClaudeBinary } from "../src/claude-context-analyzer.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/current/claude`;

test("recognizes the verified stock stable resolver", () => {
  const result = analyzeClaudeBinary(stable, { version: "2.1.197" });
  assert.equal(result.architecture, "arm64");
  assert.equal(result.attributionOffset, 213451965);
  assert.equal(result.gatewayFilterOffset, 204861577);
  assert.equal(result.contextCallCount, 18);
  assert.equal(result.compactCallCount, 13);
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
