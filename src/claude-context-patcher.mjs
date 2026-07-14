import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { analyzeClaudeBinary } from "./claude-context-analyzer.mjs";

export const PATCHER_VERSION = 6;

export const MODEL_PROVIDER_EMAILS = Object.freeze([
  Object.freeze({ pattern: /^(?:claude|anthropic)/i, email: "noreply@anthropic.com" }),
  Object.freeze({ pattern: /^(?:gpt|codex)/i, email: "noreply@openai.com" }),
  Object.freeze({ pattern: /^gemini/i, email: "gemini-code-assist[bot]@users.noreply.github.com" }),
  Object.freeze({ pattern: /^grok/i, email: "grok@x.ai" }),
  Object.freeze({ pattern: /^kimi/i, email: "noreply@moonshot.ai" }),
  Object.freeze({ pattern: /^minimax/i, email: "noreply@minimax.io" }),
  Object.freeze({ pattern: /^glm/i, email: "noreply@z.ai" }),
]);

export function providerEmailForModel(modelId) {
  return MODEL_PROVIDER_EMAILS.find(({ pattern }) => pattern.test(modelId))?.email ?? "noreply@unknown.invalid";
}

const ORIGINAL_ATTRIBUTION = "function rkm(){let e=Cs(),t=aA(e)?QAn(x9e.firstParty):UHl(e)?QAn(e):\"Claude\",n=`\\uD83E\\uDD16 Generated with [Claude Code](${E5e})`,r=`Co-Authored-By: ${t} <noreply@anthropic.com>`,o=Dr(),s=o.attribution;if(s&&(s.commit!==void 0||s.pr!==void 0))return{commit:s.commit??r,pr:s.pr??n};if(o.includeCoAuthoredBy===!1)return{commit:\"\",pr:\"\"};return{commit:r,pr:n}}function UHl(e){if(vY(e)===null)return!1;let t=vrt(e);if(t!==e&&Object.hasOwn(Art,t))return!0;let n=oo(e),r=ju(e).toLowerCase(),o=r.indexOf(n),s=n.length;if(o===-1&&n.endsWith(\"-0\")){let u=n.slice(0,-2);o=r.indexOf(u),s=u.length}if(o===-1){if(!e.includes(\"application-inference-profile\"))return!1;let u=Vxt(ju(e));return!!u&&UHl(u)}let i=r.slice(0,o),a=r.slice(o+s),l=i===\"\"||/[./]$/.test(i),c=/^(?:-fast|-latest)?(?:-v\\d+@\\d{8}|[-@]\\d{8})?(?:-v\\d+(?::\\d+)?)?$/.test(a);return l&&c}";
const PATCHED_ATTRIBUTION = "function rkm(){let e=Cs(),a=UHl(e),t=a?QAn(e):e,m=a?\"noreply@anthropic.com\":/^(gpt|codex)/.test(e)?\"noreply@openai.com\":/^gemini/.test(e)?\"gemini-code-assist[bot]@users.noreply.github.com\":/^grok/.test(e)?\"grok@x.ai\":/^kimi/.test(e)?\"noreply@moonshot.ai\":/^minimax/.test(e)?\"noreply@minimax.io\":/^glm/.test(e)?\"noreply@z.ai\":\"noreply@unknown.invalid\",n=`\\uD83E\\uDD16 Generated with [Claude Code](${E5e})`,r=`Generated-With: @callmemorgan/all-models-patch\\nCo-Authored-By: ${t} <${m}>`,o=Dr(),s=o.attribution;if(s&&(s.commit!==void 0||s.pr!==void 0))return{commit:s.commit??r,pr:s.pr??n};if(o.includeCoAuthoredBy===!1)return{commit:\"\",pr:\"\"};return{commit:r,pr:n}}function UHl(e){return /(^|[./])(?:claude|anthropic)[-./]/i.test(e)}";

const ORIGINAL_GATEWAY_FILTER = "let l=a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id));";
const PATCHED_GATEWAY_FILTER = "let l=a.data.data;";

const ORIGINAL_CONTEXT = "function Qxi(e,t){if(fg(e))return 1e6;if(t?.includes(bY.header)&&tG(e))return 1e6;if(Sx(e))return 1e6;let n=nkn(e);if(n!==null)return n;let r=Ne.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if(r!==void 0&&r>0&&!oo(Bo(e)).startsWith(\"claude-\"))return r;return cFt}";
const PATCHED_CONTEXT = "function Qxi(e,t){if(fg(e))return 1e6;if(t?.includes(bY.header)&&tG(e)||Sx(e))return 1e6;let n=+process.env[\"CLAUDE_ALL_CONTEXT_\"+e]||nkn(e);if(n)return n;let r=Ne.CLAUDE_CODE_MAX_CONTEXT_TOKENS;return r>0?r:cFt}";

const ORIGINAL_COMPACT = "function N3(e,t){let n=oo(e),r=uT(),o=rb(e,r);if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){let l=Sde(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,sBn,glo);if(l.status!==\"invalid\"){let c=Math.max(sBn,l.effective);return{window:Math.min(o,c),configured:c,source:\"env\"}}}if(t!==void 0)return{window:Math.min(o,t),configured:t,source:\"settings\"};let s=Vpp(n);if(s.window!==null)return{window:Math.min(o,s.window),configured:s.window,source:\"clientdata\"};let i=ylo(n);if(i!==void 0)return{window:Math.min(o,i),configured:i,source:\"experiment\"};if(o<1e6&&(Gpp.has(n)||DVr(e,r)))return{window:Math.min(o,bne),configured:bne,source:\"model-default\"};let a=s.replacesDefault?void 0:Wpp(n);if(a!==void 0)return{window:Math.min(o,a),configured:a,source:\"model-default\"};return{window:o,configured:o,source:\"auto\"}}";
const PATCHED_COMPACT = "function N3(e,t){let n=oo(e),r=uT(),o=rb(e,r),m=Math.min,p=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;if(p){let l=Sde(\"CLAUDE_CODE_AUTO_COMPACT_WINDOW\",p,sBn,glo);if(l.status!==\"invalid\"){let c=Math.max(sBn,l.effective);return{window:m(o,c),configured:c,source:\"env\"}}}if(t??=+process.env[\"CLAUDE_ALL_COMPACT_\"+e]||void 0,t!==void 0)return{window:m(o,t),configured:t,source:\"settings\"};let s=Vpp(n);if(s.window!==null)return{window:m(o,s.window),configured:s.window,source:\"clientdata\"};let i=ylo(n);if(i!==void 0)return{window:m(o,i),configured:i,source:\"experiment\"};if(o<1e6&&(Gpp.has(n)||DVr(e,r)))return{window:m(o,bne),configured:bne,source:\"model-default\"};let a=s.replacesDefault?void 0:Wpp(n);if(a!==void 0)return{window:m(o,a),configured:a,source:\"model-default\"};return{window:o,configured:o,source:\"auto\"}}";

export function patchClaudeBinary({ source, target, version }) {
  const analysis = analyzeClaudeBinary(source, { version });
  copyFileSync(source, target);
  const binary = readFileSync(target);
  replaceUnique(binary, ORIGINAL_ATTRIBUTION, PATCHED_ATTRIBUTION);
  replaceUnique(binary, ORIGINAL_GATEWAY_FILTER, PATCHED_GATEWAY_FILTER);
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
  if (
    count(source, PATCHED_GATEWAY_FILTER) !== 1 ||
    count(source, PATCHED_ATTRIBUTION) !== 1 ||
    count(source, PATCHED_CONTEXT) !== 1 ||
    count(source, PATCHED_COMPACT) !== 1
  ) {
    throw new Error("patched resolver fingerprints do not match exactly once");
  }
  if (
    source.includes(ORIGINAL_ATTRIBUTION) ||
    source.includes(ORIGINAL_GATEWAY_FILTER) ||
    source.includes(ORIGINAL_CONTEXT) ||
    source.includes(ORIGINAL_COMPACT)
  ) {
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
