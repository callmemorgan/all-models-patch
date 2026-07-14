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

export function analyzeClaudeBinary(path, { version } = {}) {
  const binary = readFileSync(path);
  const source = binary.toString("latin1");
  const sha256 = createHash("sha256").update(binary).digest("hex");
  const architecture = machoArchitecture(binary);
  const attributionOffset = uniqueOffset(source, ATTRIBUTION_FINGERPRINT[0]);
  const gatewayFilterOffset = uniqueOffset(source, GATEWAY_FILTER_FINGERPRINT[0]);
  const contextResolverOffset = uniqueOffset(source, CONTEXT_FINGERPRINT[0]);
  const compactResolverOffset = uniqueOffset(source, COMPACT_FINGERPRINT[0]);
  assertNeighborhood(source, attributionOffset, ATTRIBUTION_FINGERPRINT, 1_500);
  assertNeighborhood(source, gatewayFilterOffset, GATEWAY_FILTER_FINGERPRINT, 1_500);
  assertNeighborhood(source, contextResolverOffset, CONTEXT_FINGERPRINT, 1_500);
  assertNeighborhood(source, compactResolverOffset, COMPACT_FINGERPRINT, 3_500);

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
    contextCallCount: count(source, "rb("),
    compactCallCount: count(source, "N3("),
  };

  if (version) verifyKnownBuild(result, version);
  return result;
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
