import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_FIXTURE_ID,
  buildClaudeArguments,
  buildRounds,
  buildSample,
  createStreamAccumulator,
  formatBenchmarkMarkdown,
  parseBenchmarkOptions,
  runBenchmark,
  selectAgents,
  summarizeRun,
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
  });
  const sample = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult(), usage, timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(sample.telemetry.recordCount, 2);
  assert.equal(sample.telemetry.retryCount, 0);
  assert.equal(sample.telemetry.selectedAttempt.tokens.output_tokens, 1000);
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
      if (id === ids[1]) return response(404, {});
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

function usageEnvelope(id) {
  return {
    schema_version: 1,
    benchmark_id: id,
    records: [{
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
    }],
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
