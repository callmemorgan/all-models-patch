export function reviewedRecipesForClaude202(source) {
  const originals = {
    attribution: uniqueSlice(source, "function hZp(){", "function aJa(e){"),
    gateway: uniqueLiteral(source, "let l=a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id));"),
    context: uniqueSlice(source, "function _Gs(e,t){", "function TGs(){"),
    compact: uniqueSlice(source, "function v6(e,t){", "function EFe(e,t){"),
    goalToolName: uniqueLiteral(source, 'var nO="TodoWrite";'),
    goalTool: uniqueSlice(source, "var q6f,j6f,m$l;var h$l=S(()=>{", 'var g$l="TestingPermission"'),
  };
  const replacements = {
    attribution: 'function hZp(){let e=Hi(),a=dJa(e),t=a?sxr(e):e,m=a?"noreply@anthropic.com":/^(gpt|codex)/.test(e)?"noreply@openai.com":/^gemini/.test(e)?"gemini-code-assist[bot]@users.noreply.github.com":/^grok/.test(e)?"grok@x.ai":/^kimi/.test(e)?"noreply@moonshot.ai":/^minimax/.test(e)?"noreply@minimax.io":/^glm/.test(e)?"noreply@z.ai":"noreply@unknown.invalid",r=`\\uD83E\\uDD16 Generated with [Claude Code](${oGe})`,n=`Generated-With: @callmemorgan/all-models-patch\\nCo-Authored-By: ${t} <${m}>`,o=Dn(),i=o.attribution;if(i&&(i.commit!==void 0||i.pr!==void 0))return{commit:i.commit??n,pr:i.pr??r};if(o.includeCoAuthoredBy===!1)return{commit:"",pr:""};return{commit:n,pr:r}}function dJa(e){return /(^|[./])(?:claude|anthropic)[-./]/i.test(e)}',
    gateway: "let l=a.data.data;",
    context: 'function _Gs(e,t){if(Dg(e))return 1e6;if(t?.includes(GJ.header)&&a7(e))return 1e6;if(dx(e))return 1e6;let r=+process.env["CLAUDE_ALL_CONTEXT_"+e]||bLr(e);if(r)return r;let n=ke.CLAUDE_CODE_MAX_CONTEXT_TOKENS;return n>0?n:f3t}',
    compact: 'function v6(e,t){let r=Xn(e),n=NT(),o=IS(e,n),m=Math.min,p=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;if(p){let l=bpe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",p,zln,b8o);if(l.status!=="invalid"){let c=Math.max(zln,l.effective);return{window:m(o,c),configured:c,source:"env"}}}if(t??=+process.env["CLAUDE_ALL_COMPACT_"+e]||void 0,t!==void 0)return{window:m(o,t),configured:t,source:"settings"};let i=EVf(r);if(i.window!==null)return{window:m(o,i.window),configured:i.window,source:"clientdata"};let s=E8o(r);if(s!==void 0)return{window:m(o,s),configured:s,source:"experiment"};if(o<1e6&&(SVf.has(r)||mro(e,n)))return{window:m(o,Kne),configured:Kne,source:"model-default"};let a=i.replacesDefault?void 0:bVf(r);if(a!==void 0)return{window:m(o,a),configured:a,source:"model-default"};return{window:o,configured:o,source:"auto"}}',
    goalToolName: 'var nO="set_goal";',
    goalTool: 'var q6f,j6f,m$l;var h$l=S(()=>{Fn();ji();EJe();q6f=ve(()=>v.strictObject({objective:v.string().min(1).max(VCt).describe("A measurable condition and the evidence that proves it")})),m$l=Ci({name:nO,maxResultSizeChars:1e5,alwaysLoad:!0,async description(){return"Keep working until a session goal is met"},async prompt(){return"Set a measurable goal when the user asks you to work autonomously. It persists across turns, replaces any active goal, and is evaluated from evidence in the conversation."},get inputSchema(){return q6f()},userFacingName(){return"Set goal"},isEnabled(){return!0},isConcurrencySafe(){return!1},async checkPermissions(e){return{behavior:"allow",updatedInput:e}},renderToolUseMessage(){return null},async call({objective:e},t){let r=e.trim(),n=KCt(r,t);if(n!==null)throw Error(n);return{data:{objective:r}}},mapToolResultToToolResultBlockParam(e,t){return{tool_use_id:t,type:"tool_result",content:`Goal active: ${e.objective}. Continue working until it is met.`}}})});',
  };
  return Object.freeze([
    recipe("attribution", originals.attribution, replacements.attribution),
    recipe("gateway-filter", originals.gateway, replacements.gateway),
    recipe("context-resolver", originals.context, replacements.context),
    recipe("compact-resolver", originals.compact, replacements.compact),
    recipe("goal-tool-name", originals.goalToolName, replacements.goalToolName),
    recipe("goal-tool", originals.goalTool, replacements.goalTool),
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
