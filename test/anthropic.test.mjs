import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexPrompt, codexAlias, codexModelForAlias, contentToText } from "../src/anthropic.mjs";

test("Codex aliases are reversible and satisfy Claude Code discovery naming", () => {
  const model = "gpt-5.6-sol";
  const alias = codexAlias(model);
  assert.match(alias, /^claude-codex-/);
  assert.equal(codexModelForAlias(alias), model);
});

test("message conversion keeps conversation text without passing images", () => {
  const prompt = buildCodexPrompt({
    system: "Be concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the project." }, { type: "image" }] },
      { role: "assistant", content: "I will inspect it." },
    ],
    tools: [{ name: "Bash" }],
  });
  assert.match(prompt, /Be concise\./);
  assert.match(prompt, /Inspect the project\./);
  assert.match(prompt, /\[image omitted by bridge\]/);
  assert.match(prompt, /Bash/);
});

test("tool result blocks remain visible to Codex", () => {
  assert.equal(contentToText([{ type: "tool_result", content: "file contents" }]), "[tool result]\nfile contents");
});
