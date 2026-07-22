import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboardHTML } from "../src/dashboard-assets.mjs";

test("dashboard renders a complete dependency-free document with core views", () => {
  const html = renderDashboardHTML({ token: "local-secret", version: "0.7.0" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Model Cockpit · all-models-patch<\/title>/);
  assert.match(html, /role="tablist"/);
  assert.match(html, />Recommendation<\/button>/);
  assert.match(html, />Roster<\/button>/);
  assert.match(html, /id="weights"/);
  assert.match(html, /id="preset-select"/);
  assert.match(html, /id="roster-body"/);
  assert.match(html, /id="model-dialog"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
});

test("dashboard embeds its token only as an HTML-safe JavaScript string and same-origin header", () => {
  const token = `secret</script><img src=x onerror="alert(1)">&\u2028tail`;
  const html = renderDashboardHTML({ token, version: "test" });
  assert.doesNotMatch(html, /secret<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  const tokenLine = html.split("\n").find((line) => line.includes("const API_TOKEN"));
  assert.ok(tokenLine);
  assert.match(tokenLine, /\\u003c\/script\\u003e/);
  const tokenLiteral = tokenLine.match(/const API_TOKEN = (.*);$/)?.[1];
  assert.equal(JSON.parse(tokenLiteral), token);
  assert.match(html, /headers\.set\("X-All-Models-Patch-Token", API_TOKEN\)/);
  assert.match(html, /credentials: "same-origin"/);
  assert.match(html, /referrerPolicy: "no-referrer"/);
  assert.equal(html.match(/const API_TOKEN =/g)?.length, 1);
});

test("dashboard escapes the display version and validates required token", () => {
  const html = renderDashboardHTML({ token: "token", version: `<b title="x">edge</b>` });
  assert.match(html, /all-models-patch · &lt;b title=&quot;x&quot;&gt;edge&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b title="x">/);
  assert.throws(() => renderDashboardHTML(), /dashboard token must be a non-empty string/);
  assert.throws(() => renderDashboardHTML({ token: "" }), /dashboard token must be a non-empty string/);
});

test("dashboard implements the API contract and live recommendation affordances", () => {
  const html = renderDashboardHTML({ token: "token" });
  assert.match(html, /api\("\/api\/state"\)/);
  assert.match(html, /api\("\/api\/recommend", \{ method: "POST", body: currentSettings\(\) \}\)/);
  assert.match(html, /api\("\/api\/presets", \{ method: "POST"/);
  assert.match(html, /api\("\/api\/presets\/" \+ encodeURIComponent\(preset\.id\), \{ method: "DELETE" \}\)/);
  assert.match(html, /input\.type = "range"/);
  assert.match(html, /window\.setTimeout\(refreshRecommendations, 180\)/);
  assert.match(html, /data-sort="speed"/);
  assert.match(html, /openDetails\(item\.id, event\.currentTarget\)/);
  assert.match(html, /confidence/);
  assert.match(html, /provisional/);
  assert.match(html, /dimension\.id \|\| dimension\.dimensionId/);
  assert.match(html, /dimension\.weightedContribution \?\? dimension\.deltaFromNeutral \?\? dimension\.contribution/);
});

test("recommendation controls stay human-scaled and leave token handling automatic", () => {
  const html = renderDashboardHTML({ token: "token" });
  assert.match(html, />Your priorities<\/h2>/);
  assert.match(html, /fixed 500-token comparison; context uses usable runway before compaction/);
  assert.match(html, /Agents still use and compact tokens as needed/);
  assert.doesNotMatch(html, /Mission profile/);
  assert.doesNotMatch(html, /Expected output/);
  assert.doesNotMatch(html, /Required context/);
  assert.doesNotMatch(html, /id="expected-output"/);
  assert.doesNotMatch(html, /id="required-context"/);
  assert.doesNotMatch(html, /expectedOutputTokens/);
  assert.doesNotMatch(html, /requiredContextTokens/);
  assert.match(html, /function currentSettings\(\) \{\s+return \{ weights: \{ \.\.\.app\.weights \} \};\s+\}/);
});

test("evidence opens in a centered bounded desktop modal with a narrow-screen sheet", () => {
  const html = renderDashboardHTML({ token: "token" });
  assert.match(html, /<dialog id="model-dialog"[^>]*aria-describedby="drawer-description"[^>]*aria-modal="true"/);
  assert.match(html, /dialog \{[\s\S]*?inset: 0;[\s\S]*?width: min\(760px, calc\(100% - 48px\)\);[\s\S]*?max-height: min\(820px, calc\(100vh - 48px\)\);[\s\S]*?margin: auto;[\s\S]*?border-radius: 20px;/);
  assert.doesNotMatch(html, /margin: auto 0 auto auto/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?dialog \{ inset: auto 0 0;[^}]*margin: 0;[^}]*border-radius: 18px 18px 0 0;/);
});

test("every recommendation slider exposes accessible factor help", () => {
  const html = renderDashboardHTML({ token: "token" });
  const helpPhrases = [
    "task-fit and capability evidence",
    "personal judgment of polish",
    "time to first token plus post-first-token throughput",
    "sourced numeric external ratings",
    "valid completion share",
    "tightest applicable live quota window",
    "usable pre-compaction runway and never excludes a profile",
    "iterative feedback and review-driven loops",
    "lower cost or subscription-quota burn"
  ];
  helpPhrases.forEach((phrase) => assert.match(html, new RegExp(phrase)));
  assert.match(html, /node\("span", "factor-tooltip", help\)/);
  assert.match(html, /tooltip\.setAttribute\("role", "tooltip"\)/);
  assert.match(html, /input\.setAttribute\("aria-describedby", tooltipId\)/);
  assert.match(html, /helpButton\.setAttribute\("aria-describedby", tooltipId\)/);
  assert.match(html, /input\.title = help/);
  assert.match(html, /\.weight:focus-within \.factor-tooltip/);
});

test("evidence modal manages initial and return focus for every close path", () => {
  const html = renderDashboardHTML({ token: "token" });
  assert.match(html, /details\.addEventListener\("click", \(event\) => openDetails\(item\.id, event\.currentTarget\)\)/);
  assert.match(html, /identity\.addEventListener\("click", \(event\) => openDetails\(item\.id, event\.currentTarget\)\)/);
  assert.match(html, /app\.dialogTrigger = trigger && typeof trigger\.focus === "function" \? trigger : document\.activeElement/);
  assert.match(html, /byId\("close-dialog"\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /elements\.dialog\.addEventListener\("cancel", \(event\) => \{\s+event\.preventDefault\(\);\s+closeDetails\(\);/);
  assert.match(html, /elements\.dialog\.addEventListener\("close", restoreDialogFocus\)/);
  assert.match(html, /trigger\.isConnected && typeof trigger\.focus === "function"/);
  assert.match(html, /\) closeDetails\(\);/);
});

test("embedded dashboard JavaScript parses", () => {
  const html = renderDashboardHTML({ token: "token" });
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match);
  assert.doesNotThrow(() => new Function(match[1]));
});
