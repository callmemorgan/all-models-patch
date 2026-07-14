import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PATCHER_VERSION, patchClaudeBinary, verifyPatchedBytes } from "../src/claude-context-patcher.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/current/claude`;

test("patches gateway discovery to retain real provider model IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-context-patcher-"));
  const target = join(directory, "claude");

  const result = patchClaudeBinary({ source: stable, target, version: "2.1.197" });
  verifyPatchedBytes(target);

  const patched = readFileSync(target).toString("latin1");
  assert.equal(PATCHER_VERSION, 3);
  assert.equal(result.analysis.gatewayFilterOffset, 204861577);
  assert.equal(patched.includes("let l=a.data.data;"), true);
  assert.equal(patched.includes("a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id))"), false);
});
