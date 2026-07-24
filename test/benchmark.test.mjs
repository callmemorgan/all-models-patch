import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_FIXTURE_ID,
  assertLoopbackProxyURL,
  buildClaudeArguments,
  buildRounds,
  buildSample,
  createStreamAccumulator,
  formatBenchmarkMarkdown,
  parseBenchmarkOptions,
  runBenchmark,
  selectAgents,
  summarizeRun,
  validateBenchmarkUsagePayload,
  validateFixtureOutput,
} from "../src/benchmark.mjs";

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
  "123e4567-e89b-42d3-a456-426614174004",
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureOutput = Array.from({ length: 256 }, (_, index) => `${String(index + 1).padStart(3, "0")} benchmark response calibration token`).join("\n");

test("benchmark slash command is packaged with the expected plugin version", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, "0.3.0");
  assert.match(readFileSync(join(repoRoot, "plugin", "commands", "benchmark.md"), "utf8"), /all-models-patch benchmark/);
});

test("benchmark options default to all agents with one warmup and three measured runs", () => {
  const options = parseBenchmarkOptions([], { stateDirectory: "/state" });
  assert.equal(options.agents, null);
  assert.equal(options.warmups, 1);
  assert.equal(options.runs, 3);
  assert.equal(options.stateDirectory, "/state");
  assert.throws(() => parseBenchmarkOptions(["--runs", "0"], { stateDirectory: "/state" }), /positive integer/);
  assert.throws(() => parseBenchmarkOptions(["--unknown"], { stateDirectory: "/state" }), /unknown benchmark option/);
});

test("agent selection is configuration driven and rejects substitutions", () => {
  const bundle = { alpha: { model: "model-a" }, beta: { model: "model-b" } };
  assert.deepEqual(selectAgents(bundle, null), [["alpha", "model-a"], ["beta", "model-b"]]);
  assert.deepEqual(selectAgents(bundle, ["beta"]), [["beta", "model-b"]]);
  assert.throws(() => selectAgents(bundle, ["missing"]), /unknown benchmark agent/);
  assert.throws(() => selectAgents(bundle, ["alpha", "alpha"]), /duplicate benchmark agent/);
});

test("round construction is reproducible and keeps warmups separate", () => {
  const first = buildRounds(["a", "b", "c"], 1, 2, "seed");
  const second = buildRounds(["a", "b", "c"], 1, 2, "seed");
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((round) => round.phase), ["warmup", "measured", "measured"]);
  for (const round of first) assert.deepEqual([...round.agents].sort(), ["a", "b", "c"]);
});

test("benchmark disables tool advertisement instead of only tool permission", () => {
  const args = buildClaudeArguments("alpha", "prompt");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.equal(args.includes("--allowedTools"), false);
  assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "1"]);
});

test("stream accumulator times text deltas without retaining them in its result", () => {
  const stream = createStreamAccumulator(1000);
  const first = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "001 benchmark response " } } });
  const second = JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "calibration token" } } });
  stream.consume(Buffer.from(`${first}\n`), 1100);
  stream.consume(Buffer.from(`${second}\n`), 1250);
  stream.finish(1300);
  const result = stream.result();
  assert.equal(result.firstContentMS, 100);
  assert.equal(result.lastContentMS, 250);
  assert.equal(result.visibleCharacters, 40);
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("stream accumulator captures a sanitized terminal error", () => {
  const stream = createStreamAccumulator(1000);
  stream.consume(Buffer.from(`${JSON.stringify({ type: "result", subtype: "error_during_execution", error: "provider stopped" })}\n`), 1100);
  stream.finish(1200);
  assert.equal(stream.result().streamError, "provider stopped");
});

test("fixture validation requires all exact numbered lines", () => {
  assert.deepEqual(validateFixtureOutput(fixtureOutput), { ok: true, lineCount: 256 });
  assert.deepEqual(validateFixtureOutput(`${fixtureOutput}\n`), { ok: true, lineCount: 256 });
  assert.equal(validateFixtureOutput(fixtureOutput.replace("128 benchmark", "128 wrong")).ok, false);
});

test("sample metrics use authoritative proxy timing and exclude warmups", () => {
  const sample = buildSample({
    runID: ids[0],
    benchmarkID: ids[1],
    agentName: "alpha",
    configuredModel: "alias",
    phase: "measured",
    round: 1,
    ordinal: 1,
    processResult: processResult(),
    usage: usageEnvelope(ids[1]),
    timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(sample.valid, true);
  assert.equal(sample.metrics.postFirstTokenTPS, 666.67);
  assert.equal(sample.metrics.endToEndTPS, 333.33);
  assert.equal(sample.telemetry.attempts.length, 1);
  assert.equal(sample.telemetry.retryCount, 0);
  assert.equal(sample.telemetry.accountingVersion, 2);
  assert.equal(sample.telemetry.accountingQuality, "complete");
  assert.equal(JSON.stringify(sample).includes(fixtureOutput), false);

  const warmup = buildSample({
    runID: ids[0],
    benchmarkID: ids[2],
    agentName: "alpha",
    configuredModel: "alias",
    phase: "warmup",
    round: 1,
    ordinal: 1,
    processResult: processResult(),
    usage: usageEnvelope(ids[2]),
    timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(warmup.valid, false);
  assert.deepEqual(warmup.excludedReasons, ["warmup"]);
});

test("sample selection ignores smaller successful auxiliary generations", () => {
  const usage = usageEnvelope(ids[1]);
  usage.records.push({
    ...usage.records[0],
    reasoning_effort: "none",
    latency_ms: 300,
    ttft_ms: 100,
    tokens: { input_tokens: 20, output_tokens: 20, reasoning_tokens: 0, total_tokens: 40 },
    token_breakdown: canonicalBreakdown(20, 20),
  });
  const sample = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult(), usage, timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(sample.telemetry.recordCount, 2);
  assert.equal(sample.telemetry.retryCount, 0);
  assert.equal(sample.telemetry.selectedAttempt.tokens.output_tokens, 1000);
});

test("telemetry accepts rollback schema 1 and validates canonical schema 2", () => {
  const legacy = usageEnvelope(ids[1], 1);
  assert.equal(validateBenchmarkUsagePayload(legacy, ids[1]), legacy);

  const canonical = usageEnvelope(ids[2]);
  assert.equal(validateBenchmarkUsagePayload(canonical, ids[2]), canonical);

  const malformed = structuredClone(canonical);
  malformed.records[0].token_breakdown.output.total_tokens += 1;
  assert.throws(
    () => validateBenchmarkUsagePayload(malformed, ids[2]),
    /invalid benchmark telemetry/,
  );
});

test("incomplete canonical accounting excludes only that benchmark sample", () => {
  const usage = usageEnvelope(ids[1]);
  usage.records[0].token_breakdown = {
    ...canonicalBreakdown(0, 0),
    quality: "unclassified",
    total_tokens: 1020,
    unclassified_tokens: 1020,
  };
  const sample = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult(), usage, timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(sample.valid, false);
  assert(sample.excludedReasons.includes("incomplete_token_accounting"));
});

test("summary uses nearest-rank distributions and truthful partial exit codes", () => {
  const valid = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult(), usage: usageEnvelope(ids[1]), timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  const summary = summarizeRun({
    runID: ids[0], seed: "seed", startedAt: new Date("2026-07-20T12:00:00Z"), completedAt: new Date("2026-07-20T12:01:00Z"),
    outputDirectory: "/tmp/out", options: { warmups: 1, runs: 1 }, selectedAgents: [["alpha", "alias"], ["beta", "other"]], samples: [valid], interrupted: false,
  });
  assert.equal(summary.exitCode, 2);
  assert.equal(summary.agents.find((agent) => agent.name === "alpha").postFirstTokenTPS.p50, 666.67);
  assert.match(formatBenchmarkMarkdown(summary), /codex\/concrete-model/);
});

test("end-to-end harness writes redacted artifacts and honors configured output", async () => {
  const home = mkdtempSync(join(tmpdir(), "benchmark-test-"));
  const proxyDirectory = join(home, ".cli-proxy-api");
  const output = join(home, "artifacts");
  mkdirSync(proxyDirectory, { recursive: true });
  writeFileSync(join(proxyDirectory, "client-key"), "test-key\n");
  writeFileSync(join(proxyDirectory, "claude-all-agents.json"), JSON.stringify({ alpha: { model: "alias" } }));
  let uuidIndex = 0;
  const result = await runBenchmark({
    home,
    localBin: join(home, ".local", "bin"),
    stateDirectory: join(home, ".local", "state", "all-models-patch"),
    output,
    warmups: 0,
    runs: 1,
    agents: null,
    seed: "seed",
  }, {
    makeRunID: () => ids[uuidIndex++],
    now: () => new Date("2026-07-20T12:00:00Z"),
    progress: () => {},
    spawnClaude: async () => processResult(),
    fetch: async (url) => {
      const id = String(url).split("/").at(-1);
      if (id === ids[1]) return notFoundResponse();
      return response(200, usageEnvelope(id));
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.fixture.id, BENCHMARK_FIXTURE_ID);
  for (const name of ["samples.jsonl", "summary.json", "summary.md"]) {
    const content = readFileSync(join(output, name), "utf8");
    assert.equal(content.includes(fixtureOutput), false, `${name} retained output text`);
  }
});

test("proxy URL must be loopback because it carries the client key", () => {
  for (const allowed of ["http://127.0.0.1:8317", "http://localhost:8317", "https://[::1]:8317"]) {
    assert.equal(assertLoopbackProxyURL(allowed), allowed);
  }
  for (const rejected of ["https://attacker.example/proxy", "http://10.0.0.5:8317", "ftp://127.0.0.1"]) {
    assert.throws(() => assertLoopbackProxyURL(rejected), /loopback|http or https/);
  }
  assert.throws(() => assertLoopbackProxyURL("not a url"), /not a valid URL/);
});

test("an inherited remote base URL never receives the proxy credential", async () => {
  const home = benchmarkHome();
  let fetchCalls = 0;
  await assert.rejects(
    runBenchmark(benchmarkOptions(home, { proxyBaseURL: "https://attacker.example/proxy" }), {
      makeRunID: makeIDs(),
      now: () => new Date("2026-07-20T12:00:00Z"),
      progress: () => {},
      spawnClaude: async () => processResult(),
      fetch: async () => { fetchCalls += 1; return notFoundResponse(); },
    }),
    /loopback/,
  );
  assert.equal(fetchCalls, 0, "credential-bearing request was sent before the guard ran");
});

test("telemetry preflight rejects a proxy that does not implement the route", async () => {
  const home = benchmarkHome();
  await assert.rejects(
    runBenchmark(benchmarkOptions(home), {
      makeRunID: makeIDs(),
      now: () => new Date("2026-07-20T12:00:00Z"),
      progress: () => {},
      spawnClaude: async () => processResult(),
      fetch: async () => missingRouteResponse(),
    }),
    /not implemented by the proxy/,
  );
});

test("a launcher that cannot spawn still yields a partial summary and exit 2", async () => {
  const home = benchmarkHome();
  const output = join(home, "artifacts");
  const result = await runBenchmark(benchmarkOptions(home, { output }), {
    makeRunID: makeIDs(),
    now: () => new Date("2026-07-20T12:00:00Z"),
    progress: () => {},
    spawnClaude: async () => { throw new Error("spawn ENOENT"); },
    fetch: async (url) => {
      const id = String(url).split("/").at(-1);
      return id === ids[1] ? notFoundResponse() : response(200, usageEnvelope(id));
    },
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.summary.aborted, /spawn ENOENT/);
  assert.match(readFileSync(join(output, "summary.json"), "utf8"), /spawn ENOENT/);
  assert.match(result.markdown, /Run aborted/);
});

test("a malformed telemetry record fails only its own sample", async () => {
  const home = benchmarkHome();
  const output = join(home, "artifacts");
  const result = await runBenchmark(benchmarkOptions(home, { output }), {
    makeRunID: makeIDs(),
    now: () => new Date("2026-07-20T12:00:00Z"),
    progress: () => {},
    spawnClaude: async () => processResult(),
    fetch: async (url) => {
      const id = String(url).split("/").at(-1);
      if (id === ids[1]) return notFoundResponse();
      return response(200, { schema_version: 1, benchmark_id: id, records: [null] });
    },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary.aborted, null, "one bad payload aborted the whole run");
  assert.equal(result.summary.sampleCount, 1);
  assert.equal(existsSync(join(output, "summary.json")), true);
});

test("a response that does not reproduce the fixture is excluded from the distributions", () => {
  const sample = buildSample({
    runID: ids[0],
    benchmarkID: ids[1],
    agentName: "alpha",
    configuredModel: "alias",
    phase: "measured",
    round: 1,
    ordinal: 1,
    processResult: { ...processResult(), formatOK: false },
    usage: usageEnvelope(ids[1]),
    timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(sample.valid, false);
  assert(sample.excludedReasons.includes("format_failed"));
});

function benchmarkHome() {
  const home = mkdtempSync(join(tmpdir(), "benchmark-test-"));
  const proxyDirectory = join(home, ".cli-proxy-api");
  mkdirSync(proxyDirectory, { recursive: true });
  writeFileSync(join(proxyDirectory, "client-key"), "test-key\n");
  writeFileSync(join(proxyDirectory, "claude-all-agents.json"), JSON.stringify({ alpha: { model: "alias" } }));
  return home;
}

function benchmarkOptions(home, overrides = {}) {
  return {
    home,
    localBin: join(home, ".local", "bin"),
    stateDirectory: join(home, ".local", "state", "all-models-patch"),
    output: join(home, "artifacts"),
    warmups: 0,
    runs: 1,
    agents: null,
    seed: "seed",
    ...overrides,
  };
}

function makeIDs() {
  let index = 0;
  return () => ids[index++];
}

function processResult() {
  return {
    exitCode: 0,
    signal: null,
    wallDurationMS: 3000,
    stderr: "",
    firstContentMS: 500,
    lastContentMS: 2500,
    visibleCharacters: fixtureOutput.length,
    visibleBytes: Buffer.byteLength(fixtureOutput),
    visibleLines: 256,
    formatOK: true,
    finalModel: "alias",
    streamError: "",
    parseErrors: 0,
  };
}

function usageEnvelope(id, schemaVersion = 2) {
  const record = {
    provider: "codex",
    executor_type: "responses",
    model: "concrete-model",
    alias: "alias",
    latency_ms: 2000,
    ttft_ms: 500,
    generate: true,
    failed: false,
    status_code: 200,
    tokens: { input_tokens: 20, output_tokens: 1000, reasoning_tokens: 0, total_tokens: 1020 },
  };
  if (schemaVersion === 2) {
    record.accounting_version = 2;
    record.token_breakdown = canonicalBreakdown(20, 1000);
  }
  return {
    schema_version: schemaVersion,
    benchmark_id: id,
    records: [record],
  };
}

function canonicalBreakdown(inputTokens, outputTokens, reasoningTokens = 0) {
  return {
    schema_version: 2,
    quality: "complete",
    total_tokens: inputTokens + outputTokens,
    input: {
      total_tokens: inputTokens,
      uncached_tokens: inputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    output: {
      total_tokens: outputTokens,
      non_reasoning_tokens: outputTokens - reasoningTokens,
      reasoning_tokens: reasoningTokens,
    },
    unclassified_tokens: 0,
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// What the proxy returns for a valid but unknown benchmark id: the route
// exists. A proxy without the route aborts with 404 and an empty body.
function notFoundResponse() {
  return response(404, { error: "benchmark usage not found" });
}

function missingRouteResponse() {
  return { status: 404, ok: false, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } };
}
