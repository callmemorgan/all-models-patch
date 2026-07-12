import http from "node:http";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  anthropicMessage,
  buildCodexPrompt,
  codexAlias,
  codexDiscoveryModel,
  codexModelForAlias,
  writeSse,
} from "./anthropic.mjs";
import { CodexAppServer } from "./codex-client.mjs";

const ANTHROPIC_URL = "https://api.anthropic.com";
const KIMI_URL = "https://api.kimi.com/coding";
const MAX_BODY_BYTES = 40 * 1024 * 1024;
const KIMI_MODELS = new Map([
  ["claude-kimi-code", { model: "kimi-for-coding", display_name: "Kimi Code" }],
  ["claude-kimi-code-highspeed", { model: "kimi-for-coding-highspeed", display_name: "Kimi Code HighSpeed" }],
]);

const settings = {
  host: "127.0.0.1",
  port: Number(process.env.CCMB_PORT ?? parsePort(process.argv.slice(2)) ?? 18771),
  workspace: resolve(process.env.CCMB_WORKSPACE ?? process.cwd()),
  codexBin: process.env.CCMB_CODEX_BIN ?? "codex",
  readyFile: process.env.CCMB_READY_FILE ?? null,
};

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    // Do not print request bodies, headers, prompts, or provider error bodies.
    console.error(`bridge error: ${error.message}`);
    sendJson(response, 500, anthropicError("api_error", "Local bridge failed to complete the request."));
  });
});
server.requestTimeout = 11 * 60_000;
server.headersTimeout = 65_000;

server.listen(settings.port, settings.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : settings.port;
  if (settings.readyFile) {
    writeFileSync(settings.readyFile, JSON.stringify({ host: settings.host, port }), { mode: 0o600 });
  }
  console.log(`Claude Code Model Bridge listening on http://${settings.host}:${port}`);
  console.log(`Codex workspace: ${settings.workspace}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
server.on("close", () => {
  if (settings.readyFile) rmSync(settings.readyFile, { force: true });
});

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? settings.host}`);
  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, {
      status: "ok",
      auth: "Codex owns its existing login; this bridge stores no provider tokens.",
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/models") return handleModels(request, response);
  if (request.method === "POST" && url.pathname === "/v1/messages") return handleMessages(request, response);
  if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return proxyAnthropic(request, response, url.pathname);
  }
  return sendJson(response, 404, anthropicError("not_found_error", "Unknown local bridge route."));
}

async function handleModels(request, response) {
  const [codexModels, upstream] = await Promise.all([
    catalog.list(),
    fetchAnthropicModels(request).catch(() => []),
  ]);
  const models = [...upstream, ...codexModels.map(codexDiscoveryModel)];
  if (process.env.KIMI_CODE_API_KEY) {
    for (const [id, model] of KIMI_MODELS) {
      models.push({ id, display_name: model.display_name, created_at: "2026-01-01T00:00:00Z", type: "model" });
    }
  }
  sendJson(response, 200, { data: models, has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null });
}

async function handleMessages(request, response) {
  const rawBody = await readBody(request);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return sendJson(response, 400, anthropicError("invalid_request_error", "Request body must be JSON."));
  }

  const codexModel = codexModelForAlias(payload.model);
  if (codexModel) return handleCodexMessage(response, payload, codexModel);
  if (KIMI_MODELS.has(payload.model)) return proxyKimi(response, request, rawBody, payload.model);
  return proxyAnthropic(request, response, "/v1/messages", rawBody);
}

async function handleCodexMessage(response, payload, model) {
  const models = await catalog.list();
  if (!models.some((entry) => entry.model === model)) {
    return sendJson(response, 404, anthropicError("not_found_error", "That Codex model is not available to the current Codex login."));
  }

  const messageId = `msg_ccmb_${randomUUID().replaceAll("-", "")}`;
  const prompt = buildCodexPrompt(payload);
  const appServer = new CodexAppServer({ cwd: settings.workspace, codexBin: settings.codexBin });
  const stream = payload.stream === true;

  if (!stream) {
    try {
      const result = await appServer.runTurn({ model, prompt });
      return sendJson(response, 200, anthropicMessage({ id: messageId, model: payload.model, text: result.text, usage: result.usage }));
    } catch (error) {
      return sendJson(response, 502, anthropicError("api_error", `Codex bridge error: ${error.message}`));
    } finally {
      appServer.close();
    }
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(response, "message_start", {
    type: "message_start",
    message: { ...anthropicMessage({ id: messageId, model: payload.model, text: "" }), content: [], stop_reason: null },
  });
  writeSse(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

  try {
    const result = await appServer.runTurn({
      model,
      prompt,
      onDelta: (delta) => writeSse(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } }),
    });
    writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
    writeSse(response, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: result.usage?.outputTokens ?? 0 },
    });
    writeSse(response, "message_stop", { type: "message_stop" });
  } catch (error) {
    writeSse(response, "error", { type: "error", error: { type: "api_error", message: `Codex bridge error: ${error.message}` } });
  } finally {
    appServer.close();
    response.end();
  }
}

async function proxyAnthropic(request, response, pathname, preReadBody = undefined) {
  const body = preReadBody ?? (request.method === "GET" ? undefined : await readBody(request));
  const upstream = await fetch(`${ANTHROPIC_URL}${pathname}`, {
    method: request.method,
    headers: upstreamHeaders(request.headers),
    body,
    redirect: "manual",
  });
  await copyResponse(upstream, response);
}

async function fetchAnthropicModels(request) {
  const upstream = await fetch(`${ANTHROPIC_URL}/v1/models`, { headers: upstreamHeaders(request.headers), redirect: "manual" });
  if (!upstream.ok) return [];
  const json = await upstream.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function proxyKimi(response, request, rawBody, alias) {
  const config = KIMI_MODELS.get(alias);
  const payload = JSON.parse(rawBody);
  payload.model = config.model;
  const headers = upstreamHeaders(request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.set("x-api-key", process.env.KIMI_CODE_API_KEY);
  headers.set("content-type", "application/json");
  const upstream = await fetch(`${KIMI_URL}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "manual",
  });
  await copyResponse(upstream, response);
}

function upstreamHeaders(headers) {
  const forwarded = new Headers();
  for (const name of ["accept", "anthropic-beta", "anthropic-version", "authorization", "content-type", "user-agent", "x-api-key"]) {
    const value = headers[name];
    if (typeof value === "string") forwarded.set(name, value);
  }
  return forwarded;
}

async function copyResponse(upstream, response) {
  const headers = {};
  for (const name of ["content-type", "cache-control", "anthropic-ratelimit-input-tokens-limit", "anthropic-ratelimit-input-tokens-remaining", "anthropic-ratelimit-output-tokens-limit", "anthropic-ratelimit-output-tokens-remaining", "request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(upstream.status, headers);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
  else response.end();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    request.on("data", (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request exceeds the 40 MiB local bridge limit."));
      } else parts.push(part);
    });
    request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}

function parsePort(args) {
  const position = args.indexOf("--port");
  if (position === -1) return null;
  const value = Number(args[position + 1]);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : null;
}

class CodexCatalog {
  constructor({ workspace, codexBin }) {
    this.workspace = workspace;
    this.codexBin = codexBin;
    this.cached = null;
    this.expiresAt = 0;
  }

  async list() {
    if (this.cached && Date.now() < this.expiresAt) return this.cached;
    const client = new CodexAppServer({ cwd: this.workspace, codexBin: this.codexBin });
    try {
      this.cached = await client.listModels();
      this.expiresAt = Date.now() + 5 * 60_000;
      return this.cached;
    } finally {
      client.close();
    }
  }
}

const catalog = new CodexCatalog(settings);

export { CodexCatalog, KIMI_MODELS };
