import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_FIXTURE_ID,
  FIXTURES,
  assertLoopbackProxyURL,
  buildClaudeArguments,
  buildRounds,
  buildSample,
  createStreamAccumulator,
  formatBenchmarkMarkdown,
  getFixture,
  parseBenchmarkOptions,
  runBenchmark,
  selectAgents,
  summarizeRun,
  validateBenchmarkUsagePayload,
  validateFixtureOutput,
} from "../src/benchmark.mjs";
import { loadLatestBenchmarks, speedDimension } from "../src/dashboard.mjs";
import { speedUtility } from "../src/model-recommendations.mjs";

const ids = [
  "123e4567-e89b-42d3-a456-426614174000",
  "123e4567-e89b-42d3-a456-426614174001",
  "123e4567-e89b-42d3-a456-426614174002",
  "123e4567-e89b-42d3-a456-426614174003",
  "123e4567-e89b-42d3-a456-426614174004",
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureOutput = Array.from({ length: 256 }, (_, index) => `${String(index + 1).padStart(3, "0")} benchmark response calibration token`).join("\n");
const aaLongFixtureOutput = Array.from({ length: 48 }, (_, index) => `${String(index + 1).padStart(2, "0")} benchmark response calibration token`).join("\n");

test("benchmark slash command is packaged with the expected plugin version", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.version, "0.4.0");
  assert.match(readFileSync(join(repoRoot, "plugin", "commands", "benchmark.md"), "utf8"), /all-models-patch benchmark/);
  assert.match(readFileSync(join(repoRoot, "plugin", "commands", "benchmark.md"), "utf8"), /--fixture/);
  assert.match(readFileSync(join(repoRoot, "plugin", "commands", "benchmark.md"), "utf8"), /--compare-aa/);
});

test("benchmark options default to all agents with one warmup and three measured runs", () => {
  const options = parseBenchmarkOptions([], { stateDirectory: "/state" });
  assert.equal(options.agents, null);
  assert.equal(options.warmups, 1);
  assert.equal(options.runs, 3);
  assert.equal(options.fixture, "raw-v1");
  assert.equal(options.compareAa, null);
  assert.equal(options.stateDirectory, "/state");
  assert.throws(() => parseBenchmarkOptions(["--runs", "0"], { stateDirectory: "/state" }), /positive integer/);
  assert.throws(() => parseBenchmarkOptions(["--unknown"], { stateDirectory: "/state" }), /unknown benchmark option/);
  assert.throws(() => parseBenchmarkOptions(["--fixture", "nope"], { stateDirectory: "/state" }), /unknown benchmark fixture/);
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
  assert.equal(result.sawThinking, false);
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("stream accumulator captures a sanitized terminal error", () => {
  const stream = createStreamAccumulator(1000);
  stream.consume(Buffer.from(`${JSON.stringify({ type: "result", subtype: "error_during_execution", error: "provider stopped" })}\n`), 1100);
  stream.finish(1200);
  assert.equal(stream.result().streamError, "provider stopped");
});

test("stream accumulator records sawThinking for thinking blocks and deltas", () => {
  const viaStart = createStreamAccumulator(1000);
  viaStart.consume(Buffer.from(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } })}\n`), 1050);
  viaStart.consume(Buffer.from(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } })}\n`), 1100);
  viaStart.finish(1200);
  assert.equal(viaStart.result().sawThinking, true);

  const viaDelta = createStreamAccumulator(1000);
  viaDelta.consume(Buffer.from(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "..." } } })}\n`), 1050);
  viaDelta.finish(1200);
  assert.equal(viaDelta.result().sawThinking, true);
});

test("fixture validation requires all exact numbered lines", () => {
  assert.deepEqual(validateFixtureOutput(fixtureOutput), { ok: true, lineCount: 256 });
  assert.deepEqual(validateFixtureOutput(`${fixtureOutput}\n`), { ok: true, lineCount: 256 });
  assert.equal(validateFixtureOutput(fixtureOutput.replace("128 benchmark", "128 wrong")).ok, false);
});

test("aa-long-v1 validator requires exact 48-line format", () => {
  assert.deepEqual(validateFixtureOutput(aaLongFixtureOutput, "aa-long-v1"), { ok: true, lineCount: 48 });
  assert.deepEqual(validateFixtureOutput(`${aaLongFixtureOutput}\n`, "aa-long-v1"), { ok: true, lineCount: 48 });
  assert.equal(validateFixtureOutput(aaLongFixtureOutput.replace("24 benchmark", "24 wrong"), "aa-long-v1").ok, false);
  const offByOne = Array.from({ length: 47 }, (_, index) => `${String(index + 1).padStart(2, "0")} benchmark response calibration token`).join("\n");
  assert.equal(validateFixtureOutput(offByOne, "aa-long-v1").ok, false);
  assert.equal(validateFixtureOutput(offByOne, "aa-long-v1").lineCount, 47);
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
  assert.equal(sample.metrics.ttfatMS, 500);
  assert.equal(sample.process.sawThinking, false);
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
    processResult: processResult({ sawThinking: true }), usage: usageEnvelope(ids[1]), timestamp: new Date("2026-07-20T12:00:00Z"),
  });
  assert.equal(valid.process.sawThinking, true);
  const summary = summarizeRun({
    runID: ids[0], seed: "seed", startedAt: new Date("2026-07-20T12:00:00Z"), completedAt: new Date("2026-07-20T12:01:00Z"),
    outputDirectory: "/tmp/out", options: { warmups: 1, runs: 1 }, selectedAgents: [["alpha", "alias"], ["beta", "other"]], samples: [valid], interrupted: false,
  });
  assert.equal(summary.exitCode, 2);
  assert.equal(summary.agents.find((agent) => agent.name === "alpha").postFirstTokenTPS.p50, 666.67);
  assert.equal(summary.agents.find((agent) => agent.name === "alpha").ttfatMS.p50, 500);
  const markdown = formatBenchmarkMarkdown(summary);
  assert.match(markdown, /codex\/concrete-model/);
  assert.match(markdown, /TTFAT p50\/p90/);
  assert.match(markdown, /ttfatMS is client-wall-clock based/);
});

test("aa-long-v1 minOutputTokens honors 250 threshold", () => {
  const fixture = getFixture("aa-long-v1");
  const valid = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult({ visibleLines: 48, formatOK: true }),
    usage: usageEnvelope(ids[1], 2, 450),
    timestamp: new Date("2026-07-20T12:00:00Z"),
    fixture,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.fixture.id, "aa-long-v1");
  assert.equal(valid.fixture.sha256, fixture.sha256);

  const short = buildSample({
    runID: ids[0], benchmarkID: ids[2], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult({ visibleLines: 48, formatOK: true }),
    usage: usageEnvelope(ids[2], 2, 200),
    timestamp: new Date("2026-07-20T12:00:00Z"),
    fixture,
  });
  assert.equal(short.valid, false);
  assert(short.excludedReasons.includes("short_output"));
});

test("aa-story-v1 validates on character floor instead of line format", () => {
  const fixture = getFixture("aa-story-v1");
  assert.equal(fixture.expectedLines, null);
  const longProse = "Maya and her dinosaur walked the ridge at dawn. ".repeat(120);
  assert.equal(validateFixtureOutput(longProse, "aa-story-v1").ok, true);
  assert.equal(validateFixtureOutput("A short refusal.", "aa-story-v1").ok, false);

  const sample = buildSample({
    runID: ids[0], benchmarkID: ids[1], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult({ visibleCharacters: [...longProse].length, visibleLines: 1, formatOK: true }),
    usage: usageEnvelope(ids[1], 2, 1200),
    timestamp: new Date("2026-07-20T12:00:00Z"),
    fixture,
  });
  assert.equal(sample.valid, true);
  assert.equal(sample.metrics.outputTokens, 1200);

  const short = buildSample({
    runID: ids[0], benchmarkID: ids[2], agentName: "alpha", configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult({ visibleLines: 1, formatOK: true }),
    usage: usageEnvelope(ids[2], 2, 500),
    timestamp: new Date("2026-07-20T12:00:00Z"),
    fixture,
  });
  assert.equal(short.valid, false);
  assert(short.excludedReasons.includes("short_output"));
});

test("free-form fixtures rank the summary on chars per second", () => {
  const fixture = getFixture("aa-story-v1");
  const sample = (agentName, benchmarkID, charsPerSecondWindowMS) => buildSample({
    runID: ids[0], benchmarkID, agentName, configuredModel: "alias", phase: "measured", round: 1, ordinal: 1,
    processResult: processResult({
      visibleCharacters: 9000,
      visibleLines: 1,
      formatOK: true,
      firstContentMS: 1000,
      lastContentMS: 1000 + charsPerSecondWindowMS,
    }),
    usage: usageEnvelope(benchmarkID, 2, 1200),
    timestamp: new Date("2026-07-20T12:00:00Z"),
    fixture,
  });
  const samples = [sample("slow", ids[1], 9000), sample("fast", ids[2], 3000)];
  const summary = summarizeRun({
    runID: ids[0], seed: ids[0],
    startedAt: new Date("2026-07-20T12:00:00Z"), completedAt: new Date("2026-07-20T12:10:00Z"),
    outputDirectory: "/tmp/out", options: { warmups: 1, runs: 1 },
    selectedAgents: [["slow", "alias"], ["fast", "alias"]],
    samples, interrupted: false, fixture,
  });
  assert.deepEqual(summary.agents.map((agent) => agent.name), ["fast", "slow"]);
  assert.equal(summary.agents[0].visibleCharactersPerSecond.p50, 3000);
  const markdown = formatBenchmarkMarkdown(summary);
  assert.match(markdown, /Chars\/s p50\/p90/);
});

test("fixture selection runs aa-long-v1 with distinct prompt hash", async () => {
  const home = benchmarkHome();
  const output = join(home, "artifacts-aa");
  let capturedPrompt = null;
  const rawHash = FIXTURES["raw-v1"].sha256;
  const aaHash = FIXTURES["aa-long-v1"].sha256;
  assert.notEqual(rawHash, aaHash);
  assert.equal(aaHash, createHash("sha256").update(FIXTURES["aa-long-v1"].prompt).digest("hex"));

  const result = await runBenchmark(benchmarkOptions(home, { output, fixture: "aa-long-v1" }), {
    makeRunID: makeIDs(),
    now: () => new Date("2026-07-20T12:00:00Z"),
    progress: () => {},
    spawnClaude: async (args) => {
      capturedPrompt = args.prompt;
      return processResult({ visibleLines: 48, formatOK: true });
    },
    fetch: async (url) => {
      const id = String(url).split("/").at(-1);
      if (id === ids[1]) return notFoundResponse();
      return response(200, usageEnvelope(id, 2, 450));
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.fixture.id, "aa-long-v1");
  assert.equal(result.summary.fixture.sha256, aaHash);
  assert.equal(capturedPrompt, FIXTURES["aa-long-v1"].prompt);
  assert.notEqual(capturedPrompt, FIXTURES["raw-v1"].prompt);
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

test("compare-aa appends signed deltas and missing-agent rows", async () => {
  const home = benchmarkHome();
  writeFileSync(join(home, ".cli-proxy-api", "claude-all-agents.json"), JSON.stringify({
    alpha: { model: "alias" },
    beta: { model: "other" },
  }));
  const extractPath = join(home, "aa-extract.json");
  // Hand-computed: local ttfat 500ms = 0.5s vs AA 0.4s → +25%; local tok/s 666.67 vs AA 500 → +33.33%
  writeFileSync(extractPath, JSON.stringify({
    agents: {
      alpha: {
        variants: [{
          aaSlug: "alpha-slug",
          performance: {
            median_output_tokens_per_second: 500,
            median_time_to_first_answer_token_seconds: 0.4,
          },
        }],
      },
    },
  }));
  const output = join(home, "artifacts-compare");
  const result = await runBenchmark(benchmarkOptions(home, {
    output,
    compareAa: extractPath,
    agents: ["alpha", "beta"],
  }), {
    makeRunID: makeIDs(),
    now: () => new Date("2026-07-20T12:00:00Z"),
    progress: () => {},
    spawnClaude: async () => processResult(),
    fetch: async (url) => {
      const id = String(url).split("/").at(-1);
      if (id === ids[1]) return notFoundResponse();
      return response(200, usageEnvelope(id));
    },
  });
  assert.match(result.markdown, /Artificial Analysis comparison/);
  assert.match(result.markdown, /\| alpha \| 0\.4 \| 0\.5 \| \+25% \| 500 \| 666\.67 \| \+33\.33% \|/);
  assert.match(result.markdown, /\| beta \| no AA data \|/);
});

test("loadLatestBenchmarks prefers newest aa-long-v1 over raw-v1", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-latest-"));
  writeBenchmarkSummary(join(root, "raw-new"), {
    runID: "raw-new",
    fixtureId: "raw-v1",
    completedAt: "2026-07-20T12:00:00Z",
    model: "model-a",
    speed: 100,
    ttfatMS: null,
  });
  writeBenchmarkSummary(join(root, "aa-old"), {
    runID: "aa-old",
    fixtureId: "aa-long-v1",
    completedAt: "2026-07-20T11:00:00Z",
    model: "model-a",
    speed: 250,
    ttfatMS: 400,
  });
  writeBenchmarkSummary(join(root, "raw-only-agent"), {
    runID: "raw-only",
    fixtureId: "raw-v1",
    completedAt: "2026-07-20T13:00:00Z",
    model: "model-b",
    speed: 90,
    ttfatMS: null,
    agentName: "beta",
  });
  const benchmarks = loadLatestBenchmarks(root, {
    alpha: { model: "model-a" },
    beta: { model: "model-b" },
  });
  assert.equal(benchmarks.get("alpha").fixtureId, "aa-long-v1");
  assert.equal(benchmarks.get("alpha").runID, "aa-old");
  assert.equal(benchmarks.get("alpha").ttfatMS.p50, 400);
  assert.equal(benchmarks.get("beta").fixtureId, "raw-v1");
  assert.equal(benchmarks.get("beta").runID, "raw-only");

  const aaSpeed = speedDimension(benchmarks.get("alpha"));
  assert.match(aaSpeed.source, /aa-long-v1 ttfatMS\+tokPS aa-old/);
  const rawSpeed = speedDimension(benchmarks.get("beta"));
  assert.match(rawSpeed.source, /raw-v1 ttftMS\+tokPS raw-only/);
});

test("loadLatestBenchmarks prefers aa-story-v1 and speedDimension ranks it on chars/s", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-latest-"));
  writeBenchmarkSummary(join(root, "aa-long-new"), {
    runID: "aa-long-new",
    fixtureId: "aa-long-v1",
    completedAt: "2026-07-24T12:00:00Z",
    model: "model-a",
    speed: 250,
    ttfatMS: 400,
  });
  writeBenchmarkSummary(join(root, "story-old"), {
    runID: "story-old",
    fixtureId: "aa-story-v1",
    completedAt: "2026-07-24T11:00:00Z",
    model: "model-a",
    speed: 50,
    ttfatMS: 5000,
    charsPerSecond: 400,
  });
  const benchmarks = loadLatestBenchmarks(root, { alpha: { model: "model-a" } });
  assert.equal(benchmarks.get("alpha").fixtureId, "aa-story-v1");
  assert.equal(benchmarks.get("alpha").visibleCharactersPerSecond.p50, 400);

  const speed = speedDimension(benchmarks.get("alpha"));
  assert.match(speed.source, /aa-story-v1 ttfatMS\+charsPS story-old/);
  // 400 chars/s at 4 chars/token = 100 tok/s equivalent, not the raw 50 tok/s.
  const tokenEquivalent = speedUtility({ ttftMS: 5000, postFirstTokenTPS: 100 });
  assert.equal(speed.value, tokenEquivalent.value);
});

test("loadLatestBenchmarks follows symlinks that resolve to directories", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-symlink-"));
  const external = mkdtempSync(join(tmpdir(), "bench-external-"));
  writeBenchmarkSummary(external, {
    runID: "symlinked-run",
    fixtureId: "raw-v1",
    completedAt: "2026-07-20T12:00:00Z",
    model: "model-a",
    speed: 123,
    ttfatMS: null,
  });
  symlinkSync(external, join(root, "symlinked"));
  const benchmarks = loadLatestBenchmarks(root, { alpha: { model: "model-a" } });
  assert.equal(benchmarks.get("alpha").runID, "symlinked-run");
  assert.equal(benchmarks.get("alpha").postFirstTokenTPS.p50, 123);
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
    fixture: "raw-v1",
    compareAa: null,
    ...overrides,
  };
}

function makeIDs() {
  let index = 0;
  return () => ids[index++];
}

function processResult(overrides = {}) {
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
    sawThinking: false,
    ...overrides,
  };
}

function usageEnvelope(id, schemaVersion = 2, outputTokens = 1000) {
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
    tokens: { input_tokens: 20, output_tokens: outputTokens, reasoning_tokens: 0, total_tokens: 20 + outputTokens },
  };
  if (schemaVersion === 2) {
    record.accounting_version = 2;
    record.token_breakdown = canonicalBreakdown(20, outputTokens);
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

function writeBenchmarkSummary(directory, { runID, fixtureId, completedAt, model, speed, ttfatMS, charsPerSecond = null, agentName = "alpha" }) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify({
    schemaVersion: 1,
    runID,
    fixture: { id: fixtureId },
    completedAt,
    agents: [{
      name: agentName,
      configuredModel: model,
      routes: [`provider/${model}`],
      measuredSamples: 3,
      validSamples: 3,
      formatPasses: 3,
      retries: 0,
      ttftMS: { count: 3, p50: 500, p90: 600, min: 450, max: 600 },
      ttfatMS: ttfatMS === null || ttfatMS === undefined
        ? { count: 0, p50: null, p90: null, min: null, max: null }
        : { count: 3, p50: ttfatMS, p90: ttfatMS, min: ttfatMS, max: ttfatMS },
      latencyMS: { count: 3, p50: 2_000, p90: 2_100, min: 1_900, max: 2_100 },
      postFirstTokenTPS: { count: 3, p50: speed, p90: speed, min: speed, max: speed },
      endToEndTPS: { count: 3, p50: speed / 2, p90: speed / 2, min: speed / 2, max: speed / 2 },
      visibleCharactersPerSecond: charsPerSecond === null
        ? { count: 0, p50: null, p90: null, min: null, max: null }
        : { count: 3, p50: charsPerSecond, p90: charsPerSecond, min: charsPerSecond, max: charsPerSecond },
    }],
  })}\n`);
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
