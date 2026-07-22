import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { locateGatewayBootstrapSeam } from "./claude-gateway-pricing-recipe.mjs";

export const KNOWN_BUILDS = Object.freeze({
  "2.1.197": Object.freeze({
    sha256: "8cc0c4d1e4eb1dca3b0cc92ab02ee3505de764e023f8c901761c167b72041fb8",
    attributionOffset: 213451965,
    gatewayFilterOffset: 204861577,
    gatewayBootstrapOffset: 210967319,
    contextResolverOffset: 205632952,
    compactResolverOffset: 207844407,
    contextCallCount: 18,
    compactCallCount: 13,
  }),
  "2.1.201": Object.freeze({
    sha256: "a0852d76afc47b30f5cb0b7625ec9a7714cb189f2eeef6c28c77e2be954fb7fd",
    attributionOffset: 215740843,
    gatewayFilterOffset: 210059611,
    gatewayBootstrapOffset: 217139806,
    contextResolverOffset: 210833177,
    compactResolverOffset: 219494315,
    contextCallCount: 20,
    compactCallCount: 14,
  }),
  "2.1.202": Object.freeze({
    sha256: "7414f707861e2fe5afef33a466f888a8d2170e5028f5e9d2858f1d3ef45ffca5",
    attributionOffset: 222843154,
    gatewayFilterOffset: 217145527,
    gatewayBootstrapOffset: 224318518,
    contextResolverOffset: 218215492,
    compactResolverOffset: 229952621,
    contextCallCount: 22,
    compactCallCount: 22,
  }),
  "2.1.205": Object.freeze({
    sha256: "33e28624c5ae84f2bd7d2d8761e5d2e77997ba965cb11b6448de6b6e2c566f9c",
    attributionOffset: 217732550,
    gatewayFilterOffset: 212017017,
    gatewayBootstrapOffset: 219252559,
    contextResolverOffset: 212906689,
    compactResolverOffset: 221721178,
    contextCallCount: 18,
    compactCallCount: 14,
  }),
  "2.1.206": Object.freeze({
    sha256: "3197aba4442dbd5b3df42b6f35e6d7bd03b5e48ce18b7a3c5c6f5f8c28e03b7f",
    attributionOffset: 218899408,
    gatewayFilterOffset: 213171720,
    gatewayBootstrapOffset: 220421386,
    contextResolverOffset: 214063969,
    compactResolverOffset: 222910843,
    contextCallCount: 20,
    compactCallCount: 12,
  }),
});

const CONTEXT_FINGERPRINT = [
  "function rb(e,t){let n=Xxi();if(n!==void 0)return n;if(DVr(e,t))return bne;return Qxi(e,t)}",
  "function Xxi(){if(Ne.DISABLE_COMPACT&&process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)",
  "function DVr(e,t){return uQe()&&Xxi()===void 0&&Qxi(e,t)>bne}",
  "function Qxi(e,t){if(fg(e))return 1e6;",
];

const COMPACT_FINGERPRINT = [
  "function N3(e,t){let n=oo(e),r=uT(),o=rb(e,r);",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "source:\"model-default\"",
  "return{window:o,configured:o,source:\"auto\"}",
];

const GATEWAY_FILTER_FINGERPRINT = [
  "let l=a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id));",
  "[gatewayDiscovery] 0 usable models after filter",
  "models:l",
];

const ATTRIBUTION_FINGERPRINT = [
  "function rkm(){",
  "Co-Authored-By: ${t} <noreply@anthropic.com>",
  "includeCoAuthoredBy===!1",
  "function UHl(e){",
];

const BUILD_LAYOUTS = Object.freeze({
  "2.1.197": Object.freeze({
    attribution: ATTRIBUTION_FINGERPRINT,
    gateway: GATEWAY_FILTER_FINGERPRINT,
    context: CONTEXT_FINGERPRINT,
    compact: COMPACT_FINGERPRINT,
    contextCall: "rb(",
    compactCall: "N3(",
  }),
  "2.1.201": Object.freeze({
    attribution: Object.freeze([
      "function lJp(){",
      "Co-Authored-By: ${t} <noreply@anthropic.com>",
      "includeCoAuthoredBy===!1",
      "function uza(e){",
    ]),
    gateway: GATEWAY_FILTER_FINGERPRINT,
    context: Object.freeze([
      "function _1i(e,t){if(kg(e))return 1e6;",
      "let r=Ie.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "function y1i(){return rH()}",
      "function SDn(e){if(LTe())return null",
    ]),
    compact: Object.freeze([
      "function Rq(e,t){let n=oo(e),r=wT(),o=Tb(e,r);",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "source:\"model-default\"",
      "return{window:o,configured:o,source:\"auto\"}",
    ]),
    contextCall: "Tb(",
    compactCall: "Rq(",
  }),
  "2.1.202": Object.freeze({
    attribution: Object.freeze([
      "function hZp(){",
      "Co-Authored-By: ${t} <noreply@anthropic.com>",
      "includeCoAuthoredBy===!1",
      "function dJa(e){",
    ]),
    gateway: GATEWAY_FILTER_FINGERPRINT,
    context: Object.freeze([
      "function _Gs(e,t){if(Dg(e))return 1e6;",
      "let n=ke.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "function TGs(){return Pw()}",
      "function bLr(e){if(GTe())return null",
    ]),
    compact: Object.freeze([
      "function v6(e,t){let r=Xn(e),n=NT(),o=IS(e,n);",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "source:\"model-default\"",
      "return{window:o,configured:o,source:\"auto\"}",
    ]),
    contextCall: "IS(",
    compactCall: "v6(",
  }),
  "2.1.205": Object.freeze({
    attribution: Object.freeze([
      "function h_g(){",
      "Co-Authored-By: ${t} <noreply@anthropic.com>",
      "includeCoAuthoredBy===!1",
      "function vvu(e){",
    ]),
    gateway: GATEWAY_FILTER_FINGERPRINT,
    context: Object.freeze([
      "function usc(e,t){if(ST(e))return 1e6;",
      "let n=Ce.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "function dsc(){return iD()}",
      "function lMn(e){if(U$e())return null",
    ]),
    compact: Object.freeze([
      "function fV(e,t){let r=ao(e),n=NE(),o=KC(e,n);",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "source:\"model-default\"",
      "return{window:o,configured:o,source:\"auto\"}",
    ]),
    contextCall: "KC(",
    compactCall: "fV(",
  }),
  "2.1.206": Object.freeze({
    attribution: Object.freeze([
      "function OCg(){",
      "Co-Authored-By: ${t} <noreply@anthropic.com>",
      "includeCoAuthoredBy===!1",
      "function u0u(e){",
    ]),
    gateway: GATEWAY_FILTER_FINGERPRINT,
    context: Object.freeze([
      "function Jcc(e,t){if(HT(e))return 1e6;",
      "let n=we.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
      "function Xcc(){return iD()}",
    ]),
    compact: Object.freeze([
      "function HV(e,t){let r=so(e),n=WE(),o=lw(e,n);",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "source:\"model-default\"",
      "return{window:o,configured:o,source:\"auto\"}",
    ]),
    contextCall: "lw(",
    compactCall: "HV(",
  }),
});

export function analyzeClaudeBinary(path, { version } = {}) {
  const binary = readFileSync(path);
  const source = binary.toString("latin1");
  const layout = BUILD_LAYOUTS[version ?? "2.1.197"];
  if (!layout) throw new Error(`unsupported Claude Code version: ${version}`);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const architecture = machoArchitecture(binary);
  const attributionOffset = uniqueOffset(source, layout.attribution[0]);
  const gatewayFilterOffset = uniqueOffset(source, layout.gateway[0]);
  const gatewayBootstrapOffset = locateGatewayBootstrapSeam(source).offset;
  const contextResolverOffset = uniqueOffset(source, layout.context[0]);
  const compactResolverOffset = uniqueOffset(source, layout.compact[0]);
  assertNeighborhood(source, attributionOffset, layout.attribution, 1_500);
  assertNeighborhood(source, gatewayFilterOffset, layout.gateway, 1_500);
  assertNeighborhood(source, contextResolverOffset, layout.context, 1_500);
  assertNeighborhood(source, compactResolverOffset, layout.compact, 3_500);

  const result = {
    path,
    version: version ?? null,
    size: binary.length,
    sha256,
    architecture,
    attributionOffset,
    gatewayFilterOffset,
    gatewayBootstrapOffset,
    contextResolverOffset,
    compactResolverOffset,
    contextCallCount: count(source, layout.contextCall),
    compactCallCount: count(source, layout.compactCall),
  };

  if (version) verifyKnownBuild(result, version);
  return result;
}

export function inspectClaudeCandidate(path) {
  const binary = readFileSync(path);
  const source = binary.toString("latin1");
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const knownVersion = Object.entries(KNOWN_BUILDS).find(([, build]) => build.sha256 === sha256)?.[0] ?? null;
  const seams = {
    attribution: inspectSeam(source, ["function rkm(){", "function lJp(){", "function hZp(){", "function h_g(){", "function OCg(){"], ["Co-Authored-By: ${t} <noreply@anthropic.com>", "includeCoAuthoredBy===!1"]),
    gatewayFilter: inspectSeam(source, [GATEWAY_FILTER_FINGERPRINT[0]], GATEWAY_FILTER_FINGERPRINT.slice(1)),
    gatewayBootstrap: inspectGatewayBootstrap(source),
    contextResolver: inspectSeam(source, ["function Qxi(e,t){", "function _1i(e,t){", "function _Gs(e,t){", "function usc(e,t){", "function Jcc(e,t){"], ["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]),
    compactResolver: inspectSeam(source, ["function N3(e,t){", "function Rq(e,t){", "function v6(e,t){", "function fV(e,t){", "function HV(e,t){"], ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", 'source:"model-default"']),
  };
  if (knownVersion) {
    const verified = analyzeClaudeBinary(path, { version: knownVersion });
    for (const seam of Object.values(seams)) seam.status = "known-exact";
    return { status: "supported", path, version: knownVersion, size: binary.length, sha256, architecture: verified.architecture, seams };
  }
  const statuses = Object.values(seams).map((seam) => seam.status);
  return {
    status: statuses.every((status) => status === "semantic-review") ? "review-required" : "analysis-incomplete",
    path,
    version: null,
    size: binary.length,
    sha256,
    architecture: machoArchitecture(binary),
    seams,
  };
}

function inspectGatewayBootstrap(source) {
  try {
    const seam = locateGatewayBootstrapSeam(source);
    return { status: "semantic-review", offset: seam.offset, matchedStart: seam.original.slice(0, seam.original.indexOf("{") + 1), missingAnchors: [] };
  } catch {
    return { status: "missing", offset: null, matchedStart: null, candidates: 0, missingAnchors: [FETCH_GATEWAY_BOOTSTRAP] };
  }
}

const FETCH_GATEWAY_BOOTSTRAP = "[Bootstrap] Skipped gateway /v1/models";

export function verifyKnownBuild(result, version) {
  const known = KNOWN_BUILDS[version];
  if (!known) throw new Error(`unsupported Claude Code version: ${version}`);
  for (const field of Object.keys(known)) {
    if (result[field] !== known[field]) {
      throw new Error(`${field} mismatch for Claude Code ${version}: got ${result[field]}, expected ${known[field]}`);
    }
  }
  if (result.architecture !== "arm64") throw new Error(`unsupported architecture: ${result.architecture}`);
}

function uniqueOffset(source, needle) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`resolver fingerprint not found: ${needle.slice(0, 48)}`);
  if (source.indexOf(needle, first + 1) >= 0) throw new Error(`resolver fingerprint is ambiguous: ${needle.slice(0, 48)}`);
  return first;
}

function assertNeighborhood(source, offset, literals, radius) {
  const neighborhood = source.slice(offset, offset + radius);
  for (const literal of literals) {
    if (!neighborhood.includes(literal)) throw new Error(`resolver neighborhood is missing: ${literal.slice(0, 48)}`);
  }
}

function inspectSeam(source, starts, anchors) {
  const candidates = starts.flatMap((start) => {
    const offsets = [];
    let offset = 0;
    while ((offset = source.indexOf(start, offset)) >= 0) {
      offsets.push({ start, offset });
      offset += start.length;
    }
    return offsets;
  });
  const matches = candidates.filter((match) => {
    const neighborhood = source.slice(match.offset, match.offset + 4_000);
    return anchors.every((anchor) => neighborhood.includes(anchor));
  });
  if (matches.length === 0) return { status: "missing", offset: null, matchedStart: null, candidates: candidates.length, missingAnchors: anchors };
  if (matches.length > 1) return { status: "ambiguous", offset: null, matchedStart: null, candidates: matches.length };
  const match = matches[0];
  const neighborhood = source.slice(match.offset, match.offset + 4_000);
  const missingAnchors = anchors.filter((anchor) => !neighborhood.includes(anchor));
  return {
    status: missingAnchors.length === 0 ? "semantic-review" : "missing",
    offset: match.offset,
    matchedStart: match.start,
    missingAnchors,
  };
}

function count(source, needle) {
  let total = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) >= 0) {
    total += 1;
    offset += needle.length;
  }
  return total;
}

function machoArchitecture(binary) {
  if (binary.length < 8 || binary.readUInt32BE(0) !== 0xcffaedfe) return "not-mach-o-64";
  const cpuType = binary.readUInt32LE(4);
  if (cpuType === 0x0100000c) return "arm64";
  if (cpuType === 0x01000007) return "x86_64";
  return `unknown-${cpuType}`;
}
