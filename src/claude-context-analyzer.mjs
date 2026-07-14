import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const KNOWN_BUILDS = Object.freeze({
  "2.1.197": Object.freeze({
    sha256: "8cc0c4d1e4eb1dca3b0cc92ab02ee3505de764e023f8c901761c167b72041fb8",
    attributionOffset: 213451965,
    gatewayFilterOffset: 204861577,
    contextResolverOffset: 205632952,
    compactResolverOffset: 207844407,
    contextCallCount: 18,
    compactCallCount: 13,
  }),
  "2.1.201": Object.freeze({
    sha256: "a0852d76afc47b30f5cb0b7625ec9a7714cb189f2eeef6c28c77e2be954fb7fd",
    attributionOffset: 215740843,
    gatewayFilterOffset: 210059611,
    contextResolverOffset: 210833177,
    compactResolverOffset: 219494315,
    contextCallCount: 20,
    compactCallCount: 14,
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
    attribution: inspectSeam(source, ["function rkm(){", "function lJp(){"], ["Co-Authored-By: ${t} <noreply@anthropic.com>", "includeCoAuthoredBy===!1"]),
    gatewayFilter: inspectSeam(source, [GATEWAY_FILTER_FINGERPRINT[0]], GATEWAY_FILTER_FINGERPRINT.slice(1)),
    contextResolver: inspectSeam(source, ["function Qxi(e,t){", "function _1i(e,t){"], ["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]),
    compactResolver: inspectSeam(source, ["function N3(e,t){", "function Rq(e,t){"], ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", 'source:"model-default"']),
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
  const matches = starts.flatMap((start) => {
    const offsets = [];
    let offset = 0;
    while ((offset = source.indexOf(start, offset)) >= 0) {
      offsets.push({ start, offset });
      offset += start.length;
    }
    return offsets;
  });
  if (matches.length === 0) return { status: "missing", offset: null, matchedStart: null, missingAnchors: anchors };
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
