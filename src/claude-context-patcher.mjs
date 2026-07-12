import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeClaudeBinary } from "./claude-context-analyzer.mjs";

export const PATCHER_VERSION = 2;

const ORIGINAL_CONTEXT = "function Qxi(e,t){if(fg(e))return 1e6;if(t?.includes(bY.header)&&tG(e))return 1e6;if(Sx(e))return 1e6;let n=nkn(e);if(n!==null)return n;let r=Ne.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(r!==void 0&&r>0&&!oo(Bo(e)).startsWith(\"claude-\"))return r;return cFt}";
const PATCHED_CONTEXT = "function Qxi(e,t){if(fg(e))return 1e6;if(t?.includes(bY.header)&&tG(e)||Sx(e))return 1e6;let n=+process.env[\"CLAUDE_ALL_CONTEXT_\"+e]||nkn(e);if(n)return n;let r=Ne.CLAUDE_CODE_MAX_CONTEXT_TOKENS;return r>0?r:cFt}";

const ORIGINAL_COMPACT = "function N3(e,t){let n=oo(e),r=uT(),o=rb(e,r);if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=Sde(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,sBn,glo);if(l.status!==\"invalid\"){let c=Math.max(sBn,l.effective);return{window:Math.min(o,c),configured:c,source:\"env\"}}}if(t!==void 0)return{window:Math.min(o,t),configured:t,source:\"settings\"};let s=Vpp(n);if(s.window!==null)return{window:Math.min(o,s.window),configured:s.window,source:\"clientdata\"};let i=ylo(n);if(i!==void 0)return{window:Math.min(o,i),configured:i,source:\"experiment\"};if(o<1e6&&(Gpp.has(n)||DVr(e,r)))return{window:Math.min(o,bne),configured:bne,source:\"model-default\"};let a=s.replacesDefault?void 0:Wpp(n);if(a!==void 0)return{window:Math.min(o,a),configured:a,source:\"model-default\"};return{window:o,configured:o,source:\"auto\"}}";
const PATCHED_COMPACT = "function N3(e,t){let n=oo(e),r=uT(),o=rb(e,r),m=Math.min,p=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;if(p){let l=Sde(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",p,sBn,glo);if(l.status!==\"invalid\"){let c=Math.max(sBn,l.effective);return{window:m(o,c),configured:c,source:\"env\"}}}if(t??=+process.env[\"CLAUDE_ALL_COMPACT_\"+e]||void 0,t!==void 0)return{window:m(o,t),configured:t,source:\"settings\"};let s=Vpp(n);if(s.window!==null)return{window:m(o,s.window),configured:s.window,source:\"clientdata\"};let i=ylo(n);if(i!==void 0)return{window:m(o,i),configured:i,source:\"experiment\"};if(o<1e6&&(Gpp.has(n)||DVr(e,r)))return{window:m(o,bne),configured:bne,source:\"model-default\"};let a=s.replacesDefault?void 0:Wpp(n);if(a!==void 0)return{window:m(o,a),configured:a,source:\"model-default\"};return{window:o,configured:o,source:\"auto\"}}";

export function patchClaudeBinary({ source, target, version }) {
  const analysis = analyzeClaudeBinary(source, { version });
  copyFileSync(source, target);
  const binary = readFileSync(target);
  replaceUnique(binary, ORIGINAL_CONTEXT, PATCHED_CONTEXT);
  replaceUnique(binary, ORIGINAL_COMPACT, PATCHED_COMPACT);
  writeFileSync(target, binary, { mode: 0o755 });
  return {
    analysis,
    unsignedPatchedSha256: sha256(binary),
    patcherVersion: PATCHER_VERSION,
    contextMapSchema: 1,
  };
}

export function verifyPatchedBytes(path) {
  const source = readFileSync(path).toString("latin1");
  if (count(source, PATCHED_CONTEXT) !== 1 || count(source, PATCHED_COMPACT) !== 1) {
    throw new Error("patched resolver fingerprints do not match exactly once");
  }
  if (source.includes(ORIGINAL_CONTEXT) || source.includes(ORIGINAL_COMPACT)) {
    throw new Error("original resolver fingerprint remains after patching");
  }
}

export function fileSha256(path) {
  return sha256(readFileSync(path));
}

function replaceUnique(binary, original, replacement) {
  const originalBytes = Buffer.from(original);
  const replacementBytes = Buffer.from(replacement);
  if (replacementBytes.length > originalBytes.length) throw new Error("replacement exceeds original resolver length");
  const offset = binary.indexOf(originalBytes);
  if (offset < 0 || binary.indexOf(originalBytes, offset + 1) >= 0) throw new Error("patch target is missing or ambiguous");
  binary.fill(0x20, offset, offset + originalBytes.length);
  replacementBytes.copy(binary, offset);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
