import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A tiny JSON-RPC client for the locally installed `codex app-server`.
 *
 * This file never reads $CODEX_HOME/auth.json. Codex owns its login and is the
 * only process that accesses that credential.
 */
export class CodexAppServer extends EventEmitter {
  constructor({ cwd, codexBin = "codex", onDiagnostic = () => {} } = {}) {
    super();
    this.cwd = cwd ?? process.cwd();
    this.codexBin = codexBin;
    this.onDiagnostic = onDiagnostic;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
  }

  async start() {
    if (this.child) return;

    this.child = spawn(this.codexBin, ["app-server", "--stdio"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("exit", (code, signal) => {
      const detail = this.stderr.trim();
      const suffix = detail ? ` (${detail.slice(-800)})` : "";
      this.#failAll(new Error(`Codex app server stopped (${code ?? signal})${suffix}`));
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      // Retain only a small error tail. We intentionally never log its output,
      // because a provider error could include prompt fragments.
      this.stderr = (this.stderr + chunk).slice(-4_000);
    });

    const input = createInterface({ input: this.child.stdout });
    input.on("line", (line) => this.#onLine(line));

    await this.request("initialize", {
      clientInfo: { name: "claude-code-model-bridge", version: "0.1.0" },
      capabilities: { optOutNotificationMethods: [] },
    });
    this.notify("initialized", {});
  }

  async listModels() {
    await this.start();
    const collected = [];
    let cursor = null;
    do {
      const page = await this.request("model/list", { cursor, includeHidden: false });
      collected.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return collected;
  }

  async runTurn({ model, prompt, onDelta = () => {} }) {
    await this.start();
    const thread = await this.request("thread/start", {
      cwd: this.cwd,
      model,
      ephemeral: true,
      // The bridge cannot show Codex's native approval UI. Keep every Codex
      // turn read-only until we design an explicit approval relay.
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions:
        "You are serving a local compatibility bridge. Work only in the supplied cwd. " +
        "Do not request credentials, do not use network tools, and return a concise final answer.",
    });

    const { id: threadId } = thread.thread;
    let turnId = null;
    const buffered = [];
    let settle;
    const completed = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timeout = setTimeout(() => {
      cleanup();
      settle.reject(new Error("Codex did not finish within ten minutes."));
    }, 10 * 60_000);
    let output = "";

    const onNotification = (message) => {
      if (message.params?.threadId !== threadId) return;
      if (!turnId) {
        buffered.push(message);
        return;
      }
      consume(message);
    };
    const consume = (message) => {
      if (message.method === "item/agentMessage/delta" && message.params.turnId === turnId) {
        output += message.params.delta;
        onDelta(message.params.delta);
        return;
      }
      if (message.method === "turn/completed" && message.params.turn.id === turnId) {
        cleanup();
        const error = message.params.turn.error;
        if (error) settle.reject(new Error(describeTurnError(error)));
        else settle.resolve({ text: output, usage: message.params.turn.usage ?? null });
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      this.off("notification", onNotification);
    };

    this.on("notification", onNotification);
    try {
      const turnStarted = await this.request("turn/start", {
        threadId,
        model,
        input: [{ type: "text", text: prompt }],
      });
      turnId = turnStarted.turn.id;
      for (const message of buffered) consume(message);
      return await completed;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app server timed out handling ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  close() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Codex app server closed."));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
  }

  #send(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex app server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.onDiagnostic("Ignoring a non-JSON line from Codex app server.");
      return;
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app server error"));
      else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      this.#denyServerRequest(message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  #denyServerRequest(message) {
    // A server request is an approval or an interaction Codex normally shows in
    // its own UI. This bridge has no secure way to relay it, so deny it rather
    // than silently exercising a capability on the caller's behalf.
    const modern = message.method.includes("commandExecution") || message.method.includes("fileChange");
    const decision = modern ? "decline" : "denied";
    this.#send({ id: message.id, result: { decision } });
  }

  #failAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}

function describeTurnError(error) {
  if (typeof error === "string") return error;
  if (error?.message) return error.message;
  return "Codex could not complete the request.";
}
