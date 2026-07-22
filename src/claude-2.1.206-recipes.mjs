export function reviewedRecipesForClaude206(source) {
  const originals = {
    attribution: uniqueSlice(source, "function OCg(){", "function s0u(e){"),
    gateway: uniqueLiteral(source, "let l=a.data.data.filter((d)=>/^(claude|anthropic)/i.test(d.id));"),
    context: uniqueSlice(source, "function Jcc(e,t){", "function Xcc(){"),
    compact: uniqueSlice(source, "function HV(e,t){", "function ije(e,t){"),
    goalToolName: uniqueLiteral(source, 'var _U="TodoWrite";'),
    goalTool: uniqueSlice(source, "var ewy,twy,Ovd;var Lvd=T(()=>{", 'var Mvd="TestingPermission"'),
  };
  const replacements = {
    attribution: 'function OCg(){let e=Ni(),a=u0u(e),t=a?$Dn(Syt.firstParty):e,m=a?"noreply@anthropic.com":/^(gpt|codex)/.test(e)?"noreply@openai.com":/^gemini/.test(e)?"gemini-code-assist[bot]@users.noreply.github.com":/^grok/.test(e)?"grok@x.ai":/^kimi/.test(e)?"noreply@moonshot.ai":/^minimax/.test(e)?"noreply@minimax.io":/^glm/.test(e)?"noreply@z.ai":"noreply@unknown.invalid",r=`\\uD83E\\uDD16 Generated with [Claude Code](${gCt})`,n=`Generated-With: @callmemorgan/all-models-patch\\nCo-Authored-By: ${t} <${m}>`,o=$n(),i=o.attribution;if(i&&(i.commit!==void 0||i.pr!==void 0))return{commit:i.commit??n,pr:i.pr??r};if(o.includeCoAuthoredBy===!1)return{commit:"",pr:""};return{commit:n,pr:r}}function u0u(e){return /(^|[./])(?:claude|anthropic)[-./]/i.test(e)}',
    gateway: "let l=a.data.data;",
    context: 'function Jcc(e,t){if(HT(e))return 1e6;if(t?.includes(upe.header)&&L5(e))return 1e6;if(lO(e))return 1e6;let r=+process.env["CLAUDE_ALL_CONTEXT_"+e]||n2n(e);if(r)return r;let n=we.CLAUDE_CODE_MAX_CONTEXT_TOKENS;return n>0?n:gHr}',
    compact: 'function HV(e,t){let r=so(e),n=WE(),o=lw(e,n),m=Math.min,p=process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;if(p){let l=xDe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",p,V_o,pks);if(l.status!=="invalid"){let c=Math.max(V_o,l.effective);return{window:m(o,c),configured:c,source:"env"}}}if(t??=+process.env["CLAUDE_ALL_COMPACT_"+e]||void 0,t!==void 0)return{window:m(o,t),configured:t,source:"settings"};let i=pDy(r);if(i.window!==null)return{window:m(o,i.window),configured:i.window,source:"clientdata"};let s=mks(r);if(s!==void 0)return{window:m(o,s),configured:s,source:"experiment"};if(o<1e6&&(dDy.has(r)||$vi(e,n)))return{window:m(o,USe),configured:USe,source:"model-default"};let a=i.replacesDefault?void 0:uDy(r);if(a!==void 0)return{window:m(o,a),configured:a,source:"model-default"};return{window:o,configured:o,source:"auto"}}',
    goalToolName: 'var _U="set_goal";',
    goalTool: 'var ewy,twy,Ovd;var Lvd=T(()=>{Vn();ct();ns();MN();Dco();Vst();Pvd();ewy=ye(()=>E.strictObject({objective:E.string().min(1).max(oir).describe("A measurable condition and the evidence that proves it")})),Ovd=Fi({name:_U,maxResultSizeChars:1e5,alwaysLoad:!0,async description(){return"Keep working until a session goal is met"},async prompt(){return"Set a measurable goal when the user asks you to work autonomously. It persists across turns, replaces any active goal, and is evaluated from evidence in the conversation."},get inputSchema(){return ewy()},userFacingName(){return"Set goal"},isEnabled(){return!0},isConcurrencySafe(){return!1},async checkPermissions(e){return{behavior:"allow",updatedInput:e}},renderToolUseMessage(){return null},async call({objective:e},t){let r=e.trim(),n=sir(r,t);if(n!==null)throw Error(n);return{data:{objective:r}}},mapToolResultToToolResultBlockParam(e,t){return{tool_use_id:t,type:"tool_result",content:`Goal active: ${e.objective}. Continue working until it is met.`}}})});',
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
