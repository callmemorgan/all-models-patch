import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PATCHER_VERSION,
  patchClaudeBinary,
  providerEmailForModel,
  verifyPatchedBytes,
} from "../src/claude-context-patcher.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.197/claude`;

test("patches gateway discovery to retain real provider model IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-context-patcher-"));
  const target = join(directory, "claude");

  const result = patchClaudeBinary({ source: stable, target, version: "2.1.197" });
  verifyPatchedBytes(target);

  const patched = readFileSync(target).toString("latin1");
  assert.equal(PATCHER_VERSION, 7);
  assert.equal(result.analysis.attributionOffset, 213451965);
  assert.equal(result.analysis.gatewayFilterOffset, 204861577);
  assert.equal(patched.includes("let l=a.data.data;"), true);
  assert.equal(patched.includes("a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id))"), false);
  assert.equal(patched.includes("Co-Authored-By: ${t} <${m}>"), true);
  assert.equal(patched.includes("Generated-With: @callmemorgan/all-models-patch\\nCo-Authored-By: ${t} <${m}>"), true);
  assert.equal(patched.includes('UHl(e)?QAn(e):"Claude"'), false);
});

test("maps every gateway model family to its provider attribution email", () => {
  const expected = new Map([
    ["claude-fable-5", "noreply@anthropic.com"],
    ["gpt-5.6-sol", "noreply@openai.com"],
    ["codex-auto-review", "noreply@openai.com"],
    ["gemini-3.5-flash-low", "gemini-code-assist[bot]@users.noreply.github.com"],
    ["grok-4.5", "grok@x.ai"],
    ["kimi-k2.7-code-highspeed", "noreply@moonshot.ai"],
    ["minimax-m3", "noreply@minimax.io"],
    ["glm-5.2", "noreply@z.ai"],
    ["future-provider-model", "noreply@unknown.invalid"],
  ]);

  for (const [modelId, email] of expected) assert.equal(providerEmailForModel(modelId), email, modelId);
});
