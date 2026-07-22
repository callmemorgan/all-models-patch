import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { reviewedRecipesForClaude206 } from "../src/claude-2.1.206-recipes.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.206/claude`;

test("repurposes the Claude 2.1.206 TodoWrite seam as set_goal", { skip: !existsSync(stable) }, () => {
  const source = readFileSync(stable, "utf8");
  const recipes = reviewedRecipesForClaude206(source);

  assert.equal(recipes.length, 6);
  assert.deepEqual(
    recipes.map((r) => r.id),
    ["attribution", "gateway-filter", "context-resolver", "compact-resolver", "goal-tool-name", "goal-tool"]
  );

  const goalName = recipes.find((r) => r.id === "goal-tool-name");
  assert.equal(goalName.original, 'var _U="TodoWrite";');
  assert.equal(goalName.replacement, 'var _U="set_goal";');

  const goalTool = recipes.find((r) => r.id === "goal-tool");
  assert.match(goalTool.original, /searchHint:"manage the session task checklist"/);
  assert.match(goalTool.replacement, /name:_U/);
  assert.match(goalTool.replacement, /alwaysLoad:!0/);
  assert.match(goalTool.replacement, /Set a measurable goal/);

  for (const recipe of recipes) {
    assert.equal(recipe.expectedMatches, 1);
    assert(
      Buffer.byteLength(recipe.replacement) <= Buffer.byteLength(recipe.original),
      `replacement for ${recipe.id} exceeds original seam length`
    );
  }
});
