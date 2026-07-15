import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { reviewedRecipesForClaude201 } from "../src/claude-2.1.201-recipes.mjs";

const stable = `${process.env.HOME}/.local/share/claude-stable/versions/2.1.201/claude`;

test("repurposes the disabled TodoWrite seam as set_goal", { skip: !existsSync(stable) }, () => {
  const source = readFileSync(stable).toString("latin1");
  const recipes = reviewedRecipesForClaude201(source);
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

  assert.deepEqual([...byId.keys()], [
    "attribution",
    "gateway-filter",
    "context-resolver",
    "compact-resolver",
    "goal-tool-name",
    "goal-tool",
  ]);
  assert.equal(byId.get("goal-tool-name").replacement, 'var YO="set_goal";');
  assert.match(byId.get("goal-tool").replacement, /aJe\(\)/);
  assert.match(byId.get("goal-tool").replacement, /ICt\(n,t\)/);
  assert.match(byId.get("goal-tool").replacement, /alwaysLoad:!0/);
  assert.match(byId.get("goal-tool").replacement, /isEnabled\(\)\{return!0\}/);

  for (const recipe of recipes) {
    assert.ok(Buffer.byteLength(recipe.replacement) <= Buffer.byteLength(recipe.original), recipe.id);
    assert.equal(source.split(recipe.original).length - 1, 1, recipe.id);
  }
});
