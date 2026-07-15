const GATEWAY_BRANCH_ANCHOR = "[Bootstrap] Skipped gateway /v1/models";
export const GATEWAY_PRICING_PATCHER_VERSION = 9;

export function reviewedGatewayPricingRecipe(source) {
  const seam = locateGatewayBootstrapSeam(source);
  const signatureEnd = seam.original.indexOf("{") + 1;
  const gatewayReturn = seam.original.indexOf(";return ", seam.original.indexOf(GATEWAY_BRANCH_ANCHOR));
  const gatewayBranchEnd = seam.original.indexOf("}", gatewayReturn) + 1;
  const environment = seam.original.match(/if\(!([\w$]+)\.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY\)/)?.[1];
  const fetchHelper = seam.original.match(/,([\w$]+)=async\([\w$]+,[\w$]+\)=>/)?.[1];
  const apiKeyMarker = seam.original.match(/},([\w$]+)=([\w$]+)\(\);/)?.[0];
  if (signatureEnd <= 0 || gatewayReturn < 0 || gatewayBranchEnd <= 0 || !environment || !fetchHelper || !apiKeyMarker) {
    throw new Error("gateway bootstrap control flow no longer matches the reviewed layout");
  }

  const directBootstrap = `if(${environment}.ANTHROPIC_BASE_URL&&process.env.ANTHROPIC_AUTH_TOKEN)return ${fetchHelper}(${environment}.ANTHROPIC_BASE_URL,{Authorization:\`Bearer \${process.env.ANTHROPIC_AUTH_TOKEN}\`});`;
  const body = seam.original.slice(gatewayBranchEnd).replace(apiKeyMarker, `${apiKeyMarker}${directBootstrap}`);
  const replacement = `${seam.original.slice(0, signatureEnd)}${body}`;
  if (!body.includes(directBootstrap)) throw new Error("gateway bootstrap insertion point is missing");
  if (Buffer.byteLength(replacement) > Buffer.byteLength(seam.original)) {
    throw new Error("reviewed gateway pricing replacement exceeds its seam");
  }
  return Object.freeze({
    id: "gateway-pricing-bootstrap",
    original: seam.original,
    replacement,
    expectedMatches: 1,
  });
}

export function locateGatewayBootstrapSeam(source) {
  const candidates = [];
  let anchorOffset = 0;
  while ((anchorOffset = source.indexOf(GATEWAY_BRANCH_ANCHOR, anchorOffset)) >= 0) {
    const searchStart = Math.max(0, anchorOffset - 400);
    const prefix = source.slice(searchStart, anchorOffset);
    const starts = [...prefix.matchAll(/async function [\w$]+\(e\)\{/g)];
    if (starts.length > 0) {
      const offset = searchStart + starts.at(-1).index;
      const end = source.indexOf("async function ", offset + 15);
      if (end > offset && end - offset <= 3_000) candidates.push({ offset, original: source.slice(offset, end) });
    }
    anchorOffset += GATEWAY_BRANCH_ANCHOR.length;
  }
  if (candidates.length !== 1) throw new Error(`gateway bootstrap seam is missing or ambiguous: ${candidates.length} candidates`);
  return Object.freeze(candidates[0]);
}
