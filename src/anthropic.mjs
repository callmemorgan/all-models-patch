const CUSTOM_PREFIX = "claude-codex-";

export function codexAlias(model) {
  return `${CUSTOM_PREFIX}${Buffer.from(model, "utf8").toString("base64url")}`;
}

export function codexModelForAlias(alias) {
  if (!alias?.startsWith(CUSTOM_PREFIX)) return null;
  try {
    return Buffer.from(alias.slice(CUSTOM_PREFIX.length), "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

export function codexDiscoveryModel(model) {
  return {
    id: codexAlias(model.model),
    display_name: `Codex — ${model.displayName}`,
    created_at: "2026-01-01T00:00:00Z",
    type: "model",
  };
}

export function buildCodexPrompt(request) {
  const chunks = [
    "You are the coding model selected by an Anthropic-compatible client.",
    "The following is the complete conversation supplied by that client.",
    "Use your own native tools only when needed; do not emit Anthropic tool-use JSON.",
    "Return the answer for the user in plain text.",
  ];

  const system = contentToText(request.system);
  if (system) chunks.push(`\n<system>\n${system}\n</system>`);

  for (const message of request.messages ?? []) {
    chunks.push(`\n<${message.role}>\n${contentToText(message.content)}\n</${message.role}>`);
  }

  if (Array.isArray(request.tools) && request.tools.length > 0) {
    const toolNames = request.tools.map((tool) => tool.name).filter(Boolean).join(", ");
    if (toolNames) chunks.push(`\nThe calling client offered these tools: ${toolNames}. You have native equivalents.`);
  }
  return chunks.join("\n");
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "tool_result") return `[tool result]\n${contentToText(block.content)}`;
      if (block?.type === "tool_use") return `[tool call: ${block.name ?? "unknown"}]\n${JSON.stringify(block.input ?? {})}`;
      if (block?.type === "image" || block?.type === "image_url") return "[image omitted by bridge]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function anthropicMessage({ id, model, text, usage = null }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
  };
}

export function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
