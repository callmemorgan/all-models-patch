import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { reviewedRecipesForClaude202 } from "../src/claude-2.1.202-recipes.mjs";
import { reviewedRecipesForClaude205 } from "../src/claude-2.1.205-recipes.mjs";
import { reviewedRecipesForClaude206 } from "../src/claude-2.1.206-recipes.mjs";

// The seam helpers prove that the code we are REPLACING exists. Nothing proved
// that the identifiers a replacement CALLS exist in the target binary, so a
// recipe carried over from the previous release patched cleanly and failed only
// at runtime. That shipped once: the first 2.1.206 pack crashed the patched
// binary with `Te is not defined` (stale 2.1.205 minified names).
const VERSIONS = [
  { version: "2.1.202", build: reviewedRecipesForClaude202 },
  { version: "2.1.205", build: reviewedRecipesForClaude205 },
  { version: "2.1.206", build: reviewedRecipesForClaude206 },
];

const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do",
  "else", "export", "extends", "finally", "for", "function", "get", "if", "import", "in",
  "instanceof", "let", "new", "of", "return", "set", "static", "super", "switch", "this",
  "throw", "try", "typeof", "var", "void", "while", "yield",
  "true", "false", "null", "undefined", "NaN", "Infinity",
]);

const GLOBALS = new Set([
  "Array", "Boolean", "Buffer", "Date", "Error", "JSON", "Map", "Math", "Number", "Object",
  "Promise", "RegExp", "Set", "String", "Symbol", "console", "globalThis", "process",
]);

/**
 * Identifiers a replacement references but does not itself declare. Property
 * names, string contents, and object-literal keys are stripped first so only
 * free variable references remain.
 */
export function freeIdentifiers(source) {
  const code = source
    // Template literals contribute only their ${...} interpolations.
    .replace(/`(?:\\.|[^`\\])*`/g, (literal) =>
      ` ${[...literal.matchAll(/\$\{([^{}]*)\}/g)].map((match) => match[1]).join(" ")} `)
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ")
    // Regex literals in value position; their contents are not identifiers.
    .replace(
      /(^|[(,=:[!&|?{};]|\breturn\b)(\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*/g,
      "$1$2 ",
    )
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, " ")
    .replace(/([{,])\s*[A-Za-z_$][\w$]*\s*:/g, "$1")
    // Object-literal method shorthand: `{ isEnabled(){...} }`.
    .replace(/([{,])\s*(?:async\s+)?(?:get|set\s+)?[A-Za-z_$][\w$]*\s*\(/g, "$1(");

  const declared = new Set();
  for (const match of code.matchAll(/\b(?:let|var|const)\s+([^;={]+)/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().match(/^[A-Za-z_$][\w$]*/);
      if (name) declared.add(name[0]);
    }
  }
  for (const match of code.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (match[1]) declared.add(match[1]);
    for (const part of match[2].split(",")) {
      const name = part.trim().match(/^[A-Za-z_$][\w$]*/);
      if (name) declared.add(name[0]);
    }
  }
  // Arrow parameters, including the destructured single-argument form.
  for (const match of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().match(/^[A-Za-z_$][\w$]*/);
      if (name) declared.add(name[0]);
    }
  }
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1]);
  for (const match of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);

  const free = new Set();
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0];
    // Exponent suffixes are part of a number, not an identifier: 1e6 -> e6.
    if (/[\d.]/.test(code[match.index - 1] ?? "")) continue;
    // Single-character names are minifier-local bindings, not module symbols.
    if (name.length < 2) continue;
    if (RESERVED.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
    free.add(name);
  }
  return [...free].sort();
}

/**
 * Symbols a replacement legitimately introduces that do not appear in the seam
 * it replaces. Every entry is a reviewed decision: adding one means a
 * maintainer confirmed the symbol is in scope at the patch site. Keyed by
 * `${version}/${recipeId}`.
 */
const REVIEWED_NEW_SYMBOLS = {
  // set_goal caps the objective with the stock max-length constant and reuses
  // the stock validator, neither of which the TodoWrite seam referenced.
  "2.1.206/goal-tool": ["oir", "sir"],
  // Grandfathered: these packs shipped and run in production, so their symbols
  // are in scope by demonstration. Do not copy them into a newer version.
  "2.1.205/goal-tool": ["Jkt", "Mnr", "Fnr"],
  "2.1.202/goal-tool": ["EJe", "KCt", "VCt"],
};

function standalone(name, haystack) {
  // Escape first — minified names contain $, which is an anchor in a regex.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(haystack);
}

function stablePath(version) {
  return `${process.env.HOME}/.local/share/claude-stable/versions/${version}/claude`;
}

// Recipe coverage is gated on the stock binaries being present, and a plain
// skip made zero coverage look like a clean run. Name what was not checked, and
// make it a hard failure when verifying a release.
test("stock-binary coverage is reported, and required when releasing", () => {
  const missing = VERSIONS.map(({ version }) => version).filter((version) => !existsSync(stablePath(version)));
  if (missing.length > 0) {
    console.log(`recipe symbol coverage SKIPPED for: ${missing.join(", ")} (no stock binary present)`);
  }
  if (process.env.ALL_MODELS_PATCH_REQUIRE_STOCK === "1") {
    assert.deepEqual(missing, [], "release verification requires every reviewed stock binary");
  }
});

for (const { version, build } of VERSIONS) {
  const stable = stablePath(version);
  // Scope matters: this bundle reuses minified names across module scopes, so
  // "the symbol exists somewhere in the binary" proves nothing — Te, Mnr, and
  // qwy all appear in stock 2.1.206 despite being wrong at the patch site.
  // A replacement is a modified copy of its seam, so the seam is the scope we
  // can actually check; anything new must be reviewed and listed above.
  test(`every ${version} replacement symbol is in scope at its seam`, { skip: !existsSync(stable) }, () => {
    const source = readFileSync(stable, "utf8");
    const unreviewed = [];
    for (const recipe of build(source)) {
      const reviewed = REVIEWED_NEW_SYMBOLS[`${version}/${recipe.id}`] ?? [];
      for (const name of freeIdentifiers(recipe.replacement)) {
        if (standalone(name, recipe.original)) continue;
        if (reviewed.includes(name)) {
          assert(standalone(name, source), `${recipe.id}: reviewed symbol ${name} is absent from stock ${version}`);
          continue;
        }
        unreviewed.push(`${recipe.id}: ${name}`);
      }
    }
    assert.deepEqual(
      unreviewed,
      [],
      `replacement introduces symbols not present in the seam and not reviewed; `
      + `confirm each is in scope at the patch site, then add it to REVIEWED_NEW_SYMBOLS`,
    );
  });
}

test("a stale previous-release recipe fails the seam-scope check", () => {
  // The exact regression that shipped: the first 2.1.206 pack reused 2.1.205
  // names and crashed the patched binary with `Te is not defined`.
  const seam206 = 'ewy=ye(()=>E.strictObject({objective:E.string().min(1).max(oir)})),n=sir(r,t);';
  const stale205 = 'ewy=Te(()=>S.strictObject({objective:S.string().min(1).max(Mnr)})),n=Fnr(r,t);';
  const escaped = freeIdentifiers(stale205).filter((name) => !standalone(name, seam206));
  for (const name of ["Te", "Mnr", "Fnr"]) {
    assert(escaped.includes(name), `${name} would not have been flagged against the 2.1.206 seam`);
  }
});

test("free-identifier extraction ignores locals, properties, and literals", () => {
  const identifiers = freeIdentifiers(
    'function OCg(){let e=Ni(),a=u0u(e);return{commit:e.trim(),pr:`text ${gCt}`,other:Syt.firstParty}}'
    + 'function u0u(e){return /(^|[./])claude/i.test(e)}',
  );
  assert(identifiers.includes("Ni"), "missed a called module symbol");
  assert(identifiers.includes("gCt"), "missed a template-interpolated symbol");
  assert(identifiers.includes("Syt"), "missed a member-access base");
  assert.equal(identifiers.includes("OCg"), false, "kept a locally declared function");
  assert.equal(identifiers.includes("u0u"), false, "kept a locally declared function");
  assert.equal(identifiers.includes("firstParty"), false, "kept a property name");
  assert.equal(identifiers.includes("commit"), false, "kept an object-literal key");
  assert.equal(identifiers.includes("trim"), false, "kept a method name");
});

test("the extractor would have caught the stale 2.1.205 symbols in a 2.1.206 recipe", () => {
  const stale = 'ewy=Te(()=>S.strictObject({objective:S.string().min(1).max(Mnr)})),n=Fnr(r,t);';
  const identifiers = freeIdentifiers(stale);
  for (const name of ["Te", "Mnr", "Fnr"]) {
    assert(identifiers.includes(name), `extractor missed ${name}`);
  }
});
