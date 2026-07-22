import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { locateGatewayBootstrapSeam, reviewedGatewayPricingRecipe } from "../src/claude-gateway-pricing-recipe.mjs";

const version = "2.1.206";
const stable = `${process.env.HOME}/.local/share/claude-stable/versions/${version}/claude`;

test(`adds native gateway pricing bootstrap for current Stable ${version}`, { skip: !existsSync(stable) }, () => {
    const source = readFileSync(stable).toString("latin1");
    const seam = locateGatewayBootstrapSeam(source);
    const recipe = reviewedGatewayPricingRecipe(source);

    assert.equal(recipe.id, "gateway-pricing-bootstrap");
    assert.equal(recipe.original, seam.original);
    assert.equal(source.split(recipe.original).length - 1, 1);
    assert.ok(Buffer.byteLength(recipe.replacement) <= Buffer.byteLength(recipe.original));
    assert.match(recipe.replacement, /\/api\/claude_cli\/bootstrap/);
    assert.match(recipe.replacement, /ANTHROPIC_AUTH_TOKEN/);
    assert.doesNotMatch(recipe.replacement, /Skipped gateway \/v1\/models/);
});

test("rejects unreviewed gateway bootstrap layouts", () => {
  assert.throws(() => reviewedGatewayPricingRecipe("[Bootstrap] Gateway /v1/models fetch failed"), /missing or ambiguous/);
});
