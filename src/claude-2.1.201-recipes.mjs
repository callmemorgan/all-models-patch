export function reviewedRecipesForClaude201(source) {
  const originals = {
    attribution: uniqueSlice(source, "function lJp(){", "function iza(e){"),
    gateway: uniqueLiteral(source, "let l=a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id));"),
    context: uniqueSlice(source, "function _1i(e,t){", "function y1i(){"),
    compact: uniqueSlice(source, "function Rq(e,t){", "function SUe(e,t){"),
  };
  const replacements = {
    attribution: 'function lJp(){let e=Is(),a=uza(e),t=a?fxn(e):e,m=a?"noreply@anthropic.com":/^(gpt|codex)/.test(e)?"noreply@openai.com":/^gemini/.test(e)?"gemini-code-assist[bot]@users.noreply.github.com":/^grok/.test(e)?"grok@x.ai":/^kimi/.test(e)?"noreply@moonshot.ai":/^minimax/.test(e)?"noreply@minimax.io":/^glm/.test(e)?"noreply@z.ai":"noreply@unknown.invalid",n=`\\uD83E\\uDD16 Generated with [Claude Code](${X8e})`,r=`Generated-With: @callmemorgan/all-models-patch\\nCo-Authored-By: ${t} <${m}>`,o=Hr(),s=o.attribution;if(s&&(s.commit!==void 0||s.pr!==void 0))return{commit:s.commit??r,pr:s.pr??n};if(o.includeCoAuthoredBy===!1)return{commit:"",pr:""};return{commit:r,pr:n}}function uza(e){return /(^|[./])(?:claude|anthropic)[-./]/i.test(e)}',
    gateway: "let l=a.data.data;",
    context: 'function _1i(e,t){if(kg(e))return 1e6;if(t?.includes(qJ.header)&&uV(e)||lk(e))return 1e6;let n=+process.env["CLAUDE_ALL_CONTEXT_"+e]||SDn(e);if(n)return n;let r=Ie.CLAUDE_CODE_MAX_CONTEXT_TOKENS;return r>0?r:$$t}',
    compact: 'function Rq(e,t){let n=oo(e),r=wT(),o=Tb(e,r),m=Math.min,p=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;if(p){let l=ipe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",p,Uar,Iqo);if(l.status!=="invalid"){let c=Math.max(Uar,l.effective);return{window:m(o,c),configured:c,source:"env"}}}if(t??=+process.env["CLAUDE_ALL_COMPACT_"+e]||void 0,t!==void 0)return{window:m(o,t),configured:t,source:"settings"};let s=qWm(n);if(s.window!==null)return{window:m(o,s.window),configured:s.window,source:"clientdata"};let i=Dqo(n);if(i!==void 0)return{window:m(o,i),configured:i,source:"experiment"};if(o<1e6&&($Wm.has(n)||JXr(e,r)))return{window:m(o,Ore),configured:Ore,source:"model-default"};let a=s.replacesDefault?void 0:BWm(n);if(a!==void 0)return{window:m(o,a),configured:a,source:"model-default"};return{window:o,configured:o,source:"auto"}}',
  };
  return Object.freeze([
    recipe("attribution", originals.attribution, replacements.attribution),
    recipe("gateway-filter", originals.gateway, replacements.gateway),
    recipe("context-resolver", originals.context, replacements.context),
    recipe("compact-resolver", originals.compact, replacements.compact),
  ]);
}

function recipe(id, original, replacement) {
  if (Buffer.byteLength(replacement) > Buffer.byteLength(original)) throw new Error(`reviewed replacement exceeds ${id} seam`);
  return Object.freeze({ id, original, replacement, expectedMatches: 1 });
}

function uniqueLiteral(source, literal) {
  const offset = source.indexOf(literal);
  if (offset < 0 || source.indexOf(literal, offset + 1) >= 0) throw new Error(`reviewed literal is missing or ambiguous: ${literal.slice(0, 48)}`);
  return literal;
}

function uniqueSlice(source, start, end) {
  const offset = source.indexOf(start);
  if (offset < 0 || source.indexOf(start, offset + 1) >= 0) throw new Error(`reviewed seam start is missing or ambiguous: ${start}`);
  const limit = source.indexOf(end, offset);
  if (limit < 0) throw new Error(`reviewed seam end is missing: ${end}`);
  return source.slice(offset, limit);
}
