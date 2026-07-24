import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const PROXY_TELEMETRY_SCHEMA_VERSION = 2;
export const BENCHMARK_FIXTURE_ID = "raw-v1";
export const BENCHMARK_HEADER = "X-Claude-All-Benchmark-ID";
export const DEFAULT_WARMUPS = 1;
export const DEFAULT_RUNS = 3;

export const BENCHMARK_PROMPT = `Produce exactly 256 lines and nothing else.
For each integer from 1 through 256, output one line in ascending order using this exact format:
NNN benchmark response calibration token
Replace NNN with the integer zero-padded to three digits, beginning with 001 and ending with 256.
Do not use a code fence, heading, introduction, conclusion, tool, or commentary.`;

function buildAaLongPrompt() {
  const paragraphs = Array.from({ length: 250 }, (_, index) => {
    const n = String(index + 1).padStart(3, "0");
    return `Paragraph ${n}: This is deterministic filler text for Artificial Analysis style long-context calibration. The content is fixed so hashes stay stable across builds and machines. Token packing line ${n} repeats controlled wording for density.`;
  }).join("\n\n");
  return `${paragraphs}

After the preceding context, produce exactly 48 lines and nothing else.
For each integer from 1 through 48, output one line in ascending order using this exact format:
NN benchmark response calibration token
Replace NN with the integer zero-padded to two digits, beginning with 01 and ending with 48.
Do not use a code fence, heading, introduction, conclusion, tool, or commentary.`;
}

function freezeFixture(id, prompt, { minOutputTokens, expectedLines, linePadWidth }) {
  return Object.freeze({
    id,
    prompt,
    minOutputTokens,
    expectedLines,
    linePadWidth,
    sha256: createHash("sha256").update(prompt).digest("hex"),
  });
}

export const FIXTURES = Object.freeze({
  "raw-v1": freezeFixture("raw-v1", BENCHMARK_PROMPT, {
    minOutputTokens: 512,
    expectedLines: 256,
    linePadWidth: 3,
  }),
  "aa-long-v1": freezeFixture("aa-long-v1", buildAaLongPrompt(), {
    minOutputTokens: 400,
    expectedLines: 48,
    linePadWidth: 2,
  }),
});

export function getFixture(fixtureId = BENCHMARK_FIXTURE_ID) {
  const fixture = FIXTURES[fixtureId];
  if (!fixture) throw new Error(`unknown benchmark fixture: ${fixtureId}`);
  return fixture;
}

export function parseBenchmarkOptions(argv, paths) {
  const options = {
    agents: null,
    warmups: DEFAULT_WARMUPS,
    runs: DEFAULT_RUNS,
    seed: null,
    output: null,
    json: false,
    fixture: BENCHMARK_FIXTURE_ID,
    compareAa: null,
  };
  const valueOptions = new Set(["--agents", "--warmups", "--runs", "--seed", "--output", "--fixture", "--compare-aa"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!valueOptions.has(arg)) throw new Error(`unknown benchmark option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === "--agents") {
      const agents = value.split(",").map((item) => item.trim()).filter(Boolean);
      options.agents = agents.length === 1 && agents[0] === "all" ? null : agents;
      if (options.agents?.length === 0) throw new Error("--agents requires at least one agent name");
    } else if (arg === "--warmups") {
      options.warmups = parseCount(value, "--warmups", true);
    } else if (arg === "--runs") {
      options.runs = parseCount(value, "--runs", false);
    } else if (arg === "--seed") {
      options.seed = value;
    } else if (arg === "--output") {
      options.output = resolve(value);
    } else if (arg === "--fixture") {
      if (!Object.hasOwn(FIXTURES, value)) throw new Error(`unknown benchmark fixture: ${value}`);
      options.fixture = value;
    } else if (arg === "--compare-aa") {
      options.compareAa = resolve(value);
    }
  }
  options.stateDirectory = paths.stateDirectory;
  return options;
}

export async function runBenchmark(options, dependencies = {}) {
  const deps = {
    readFile: readFileSync,
    makeRunID: randomUUID,
    spawnClaude: runClaudeProcess,
    fetch: globalThis.fetch,
    now: () => new Date(),
    clock: () => performance.now(),
    progress: (line) => process.stderr.write(`${line}\n`),
    ...dependencies,
  };
  if (typeof deps.fetch !== "function") throw new Error("benchmark requires fetch support");

  const fixture = getFixture(options.fixture ?? BENCHMARK_FIXTURE_ID);
  const agentsPath = join(options.home, ".cli-proxy-api", "claude-all-agents.json");
  const keyPath = join(options.home, ".cli-proxy-api", "client-key");
  const launcher = options.launcher ?? join(options.localBin, "claude-all");
  const agentBundle = loadAgentBundle(agentsPath, deps.readFile);
  const selectedAgents = selectAgents(agentBundle, options.agents);
  const clientKey = String(deps.readFile(keyPath, "utf8")).trim();
  if (!clientKey) throw new Error(`proxy credential is empty: ${keyPath}`);

  const runID = deps.makeRunID();
  const seed = options.seed ?? runID;
  const startedAt = deps.now();
  const outputDirectory = options.output ?? join(options.stateDirectory, "benchmarks", `${safeTimestamp(startedAt)}-${runID}`);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const samplesPath = join(outputDirectory, "samples.jsonl");
  const proxyBaseURL = assertLoopbackProxyURL(
    String(options.proxyBaseURL ?? process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:8317").replace(/\/+$/, ""),
  );
  await verifyTelemetryEndpoint(proxyBaseURL, clientKey, deps.fetch, deps.makeRunID());
  const sampleStream = createWriteStream(samplesPath, { flags: "wx", mode: 0o600 });
  let streamFailure = null;
  sampleStream.on("error", (error) => { streamFailure ??= error; });

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-all-benchmark-"));
  const samples = [];
  let activeChild = null;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  let aborted = null;
  try {
    const rounds = buildRounds(selectedAgents.map(([name]) => name), options.warmups, options.runs, seed);
    const total = rounds.reduce((count, round) => count + round.agents.length, 0);
    let ordinal = 0;
    for (const round of rounds) {
      for (const agentName of round.agents) {
        if (interrupted) break;
        ordinal += 1;
        const configuredModel = agentBundle[agentName].model;
        const benchmarkID = deps.makeRunID();
        deps.progress(`[${ordinal}/${total}] ${round.phase} ${agentName} (${configuredModel})`);
        let processResult;
        try {
          processResult = await deps.spawnClaude({
            launcher,
            cwd: temporaryDirectory,
            agent: agentName,
            benchmarkID,
            prompt: fixture.prompt,
            fixtureId: fixture.id,
            environment: process.env,
            clock: deps.clock,
            onChild: (child) => { activeChild = child; },
          });
        } catch (error) {
          activeChild = null;
          aborted = `could not run ${launcher}: ${error.message}`;
          break;
        }
        activeChild = null;
        if (streamFailure) {
          aborted = `could not write ${samplesPath}: ${streamFailure.message}`;
          break;
        }
        let usage;
        if (interrupted) {
          usage = { schema_version: PROXY_TELEMETRY_SCHEMA_VERSION, benchmark_id: benchmarkID, records: [], error: "benchmark interrupted" };
        } else {
          try {
            usage = await pollBenchmarkUsage(proxyBaseURL, clientKey, benchmarkID, deps.fetch);
          } catch (error) {
            usage = { schema_version: PROXY_TELEMETRY_SCHEMA_VERSION, benchmark_id: benchmarkID, records: [], error: error.message };
          }
        }
        const sample = buildSample({
          runID,
          benchmarkID,
          agentName,
          configuredModel,
          phase: round.phase,
          round: round.number,
          ordinal,
          processResult,
          usage,
          timestamp: deps.now(),
          fixture,
        });
        samples.push(sample);
        try {
          await writeJSONLine(sampleStream, sample);
        } catch (error) {
          aborted = `could not write ${samplesPath}: ${error.message}`;
          break;
        }
      }
      if (interrupted || aborted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    // The stream carries its own error listener, so a close failure is already
    // recorded in streamFailure; never let it mask the partial-result summary.
    await closeStream(sampleStream).catch((error) => { streamFailure ??= error; });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  if (!aborted && streamFailure) aborted = `could not write ${samplesPath}: ${streamFailure.message}`;

  let compareAa = null;
  if (options.compareAa) {
    compareAa = loadAaCompareExtract(options.compareAa, deps.readFile);
  }

  const summary = summarizeRun({
    runID,
    seed,
    startedAt,
    completedAt: deps.now(),
    outputDirectory,
    options,
    selectedAgents,
    samples,
    interrupted,
    aborted,
    fixture,
    compareAa,
  });
  writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  const markdown = formatBenchmarkMarkdown(summary);
  writeFileSync(join(outputDirectory, "summary.md"), `${markdown}\n`, { mode: 0o600 });
  return { summary, markdown, exitCode: summary.exitCode };
}

export function loadAgentBundle(path, readFile = readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`could not read agent bundle ${path}: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`agent bundle must be an object: ${path}`);
  for (const [name, definition] of Object.entries(parsed)) {
    if (!name.trim() || !definition || typeof definition !== "object" || typeof definition.model !== "string" || !definition.model.trim()) {
      throw new Error(`agent bundle entry ${JSON.stringify(name)} is missing a model`);
    }
  }
  if (Object.keys(parsed).length === 0) throw new Error(`agent bundle is empty: ${path}`);
  return parsed;
}

export function selectAgents(bundle, requested) {
  const names = requested ?? Object.keys(bundle);
  const seen = new Set();
  const selected = [];
  for (const name of names) {
    if (!Object.hasOwn(bundle, name)) throw new Error(`unknown benchmark agent: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate benchmark agent: ${name}`);
    seen.add(name);
    selected.push([name, bundle[name].model]);
  }
  return selected;
}

export function buildRounds(agentNames, warmups, runs, seed) {
  const random = seededRandom(seed);
  const rounds = [];
  for (let number = 1; number <= warmups; number += 1) {
    rounds.push({ phase: "warmup", number, agents: shuffle(agentNames, random) });
  }
  for (let number = 1; number <= runs; number += 1) {
    rounds.push({ phase: "measured", number, agents: shuffle(agentNames, random) });
  }
  return rounds;
}

export async function runClaudeProcess({ launcher, cwd, agent, benchmarkID, prompt, environment, clock, onChild, fixtureId = BENCHMARK_FIXTURE_ID }) {
  const args = buildClaudeArguments(agent, prompt);
  const env = {
    ...environment,
    ANTHROPIC_CUSTOM_HEADERS: appendBenchmarkHeader(environment.ANTHROPIC_CUSTOM_HEADERS, benchmarkID),
  };
  const started = clock();
  const stream = createStreamAccumulator(started, fixtureId);
  let stderr = "";
  const child = spawn(launcher, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  onChild?.(child);
  child.stdout.on("data", (chunk) => stream.consume(chunk, clock()));
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length);
  });
  const result = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => resolvePromise({ code, signal }));
  });
  stream.finish(clock());
  return {
    exitCode: result.code,
    signal: result.signal,
    wallDurationMS: Math.max(0, clock() - started),
    stderr: sanitizeError(stderr),
    ...stream.result(),
  };
}

export function buildClaudeArguments(agent, prompt) {
  return [
    "--bare",
    "-p",
    "--agent", agent,
    "--max-turns", "1",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--permission-mode", "plan",
    "--tools", "",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    prompt,
  ];
}

export function createStreamAccumulator(startedAt, fixtureId = BENCHMARK_FIXTURE_ID) {
  let buffer = "";
  let text = "";
  let firstContentMS = null;
  let lastContentMS = null;
  let finalAssistantText = "";
  let finalModel = "";
  let streamError = "";
  let parseErrors = 0;
  let sawThinking = false;

  function processLine(line, timestamp) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors += 1;
      return;
    }
    if (event.type === "stream_event" && event.event?.type === "content_block_start" && event.event.content_block?.type === "thinking") {
      sawThinking = true;
    }
    if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "thinking_delta") {
      sawThinking = true;
    }
    if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
      const delta = String(event.event.delta.text ?? "");
      if (delta) {
        if (firstContentMS === null) firstContentMS = Math.max(0, timestamp - startedAt);
        lastContentMS = Math.max(0, timestamp - startedAt);
        text += delta;
      }
    }
    if (event.type === "assistant" && event.message) {
      finalModel = String(event.message.model ?? finalModel);
      const content = Array.isArray(event.message.content)
        ? event.message.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("")
        : "";
      if (content) finalAssistantText = content;
    }
    if (event.type === "result" && event.subtype && event.subtype !== "success") {
      const detail = event.error ?? event.result ?? event.subtype;
      streamError = sanitizeError(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
  }

  return {
    consume(chunk, timestamp) {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processLine(line, timestamp);
      }
    },
    finish(timestamp) {
      if (buffer.trim()) processLine(buffer, timestamp);
      buffer = "";
      if (!text && finalAssistantText) {
        text = finalAssistantText;
        firstContentMS = Math.max(0, timestamp - startedAt);
        lastContentMS = firstContentMS;
      }
    },
    result() {
      const validation = validateFixtureOutput(text, fixtureId);
      return {
        firstContentMS,
        lastContentMS,
        visibleCharacters: [...text].length,
        visibleBytes: Buffer.byteLength(text),
        visibleLines: validation.lineCount,
        formatOK: validation.ok,
        finalModel,
        streamError,
        parseErrors,
        sawThinking,
      };
    },
  };
}

export function validateFixtureOutput(text, fixtureId = BENCHMARK_FIXTURE_ID) {
  const fixture = getFixture(fixtureId);
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = normalized ? normalized.split("\n") : [];
  if (lines.length !== fixture.expectedLines) return { ok: false, lineCount: lines.length };
  for (let index = 0; index < lines.length; index += 1) {
    const expected = `${String(index + 1).padStart(fixture.linePadWidth, "0")} benchmark response calibration token`;
    if (lines[index] !== expected) return { ok: false, lineCount: lines.length };
  }
  return { ok: true, lineCount: lines.length };
}

export function buildSample({ runID, benchmarkID, agentName, configuredModel, phase, round, ordinal, processResult, usage, timestamp, fixture = FIXTURES[BENCHMARK_FIXTURE_ID] }) {
  const generated = usage.records.filter((record) => record.generate !== false);
  const successful = generated.filter((record) => !record.failed && Number(record.tokens?.output_tokens) > 0);
  const selected = [...successful].sort((left, right) => Number(right.tokens?.output_tokens ?? 0) - Number(left.tokens?.output_tokens ?? 0))[0]
    ?? generated.at(-1)
    ?? null;
  const outputTokens = Number(selected?.tokens?.output_tokens ?? 0);
  const latencyMS = Number(selected?.latency_ms ?? 0);
  const ttftMS = Number(selected?.ttft_ms ?? 0);
  const decodeWindowMS = latencyMS - ttftMS;
  const visibleWindowMS = processResult.firstContentMS !== null && processResult.lastContentMS !== null
    ? processResult.lastContentMS - processResult.firstContentMS
    : 0;
  const reasons = [];
  if (phase !== "measured") reasons.push("warmup");
  if (processResult.exitCode !== 0) reasons.push("process_failed");
  if (!selected || selected.failed) reasons.push("generation_failed");
  if (outputTokens < fixture.minOutputTokens) reasons.push("short_output");
  if (!(decodeWindowMS > 0)) reasons.push("invalid_timing");
  const accountingVersion = usage.schema_version === 2
    ? Number(selected?.accounting_version ?? 0)
    : 1;
  const accountingQuality = usage.schema_version === 2
    ? String(selected?.token_breakdown?.quality ?? "")
    : "legacy";
  if (selected && usage.schema_version === 2 && accountingQuality !== "complete") {
    reasons.push("incomplete_token_accounting");
  }
  // A response that does not reproduce the fixture exactly did different work,
  // so its timings are not comparable and must stay out of the distributions.
  if (!processResult.formatOK) reasons.push("format_failed");
  const valid = phase === "measured" && reasons.length === 0;
  const ttfatMS = processResult.firstContentMS === null || processResult.firstContentMS === undefined
    ? null
    : nullableRound(processResult.firstContentMS);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runID,
    benchmarkID,
    timestamp: timestamp.toISOString(),
    fixture: { id: fixture.id, sha256: fixture.sha256 },
    agent: agentName,
    configuredModel,
    phase,
    round,
    ordinal,
    process: {
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      wallDurationMS: roundNumber(processResult.wallDurationMS),
      firstContentMS: nullableRound(processResult.firstContentMS),
      lastContentMS: nullableRound(processResult.lastContentMS),
      finalModel: processResult.finalModel,
      parseErrors: processResult.parseErrors,
      error: processResult.stderr || processResult.streamError || null,
      sawThinking: Boolean(processResult.sawThinking),
    },
    output: {
      visibleCharacters: processResult.visibleCharacters,
      visibleBytes: processResult.visibleBytes,
      visibleLines: processResult.visibleLines,
      formatOK: processResult.formatOK,
    },
    telemetry: {
      recordCount: generated.length,
      retryCount: generated.filter((record) => record.failed).length,
      attempts: generated,
      selectedAttempt: selected,
      accountingVersion,
      accountingQuality,
      error: usage.error ?? null,
    },
    metrics: {
      ttftMS: selected ? ttftMS : null,
      ttfatMS,
      latencyMS: selected ? latencyMS : null,
      postFirstTokenTPS: decodeWindowMS > 0 ? roundNumber(outputTokens / (decodeWindowMS / 1000)) : null,
      endToEndTPS: processResult.wallDurationMS > 0 ? roundNumber(outputTokens / (processResult.wallDurationMS / 1000)) : null,
      visibleCharactersPerSecond: visibleWindowMS > 0
        ? roundNumber(processResult.visibleCharacters / (visibleWindowMS / 1000))
        : null,
    },
    valid,
    excludedReasons: reasons,
  };
}

export function summarizeRun({ runID, seed, startedAt, completedAt, outputDirectory, options, selectedAgents, samples, interrupted, aborted = null, fixture = FIXTURES[BENCHMARK_FIXTURE_ID], compareAa = null }) {
  const agents = selectedAgents.map(([name, configuredModel]) => {
    const measured = samples.filter((sample) => sample.agent === name && sample.phase === "measured");
    const valid = measured.filter((sample) => sample.valid);
    const routeNames = [...new Set(valid.map((sample) => {
      const record = sample.telemetry.selectedAttempt;
      return [record.provider, record.model].filter(Boolean).join("/");
    }).filter(Boolean))];
    return {
      name,
      configuredModel,
      routes: routeNames,
      measuredSamples: measured.length,
      validSamples: valid.length,
      formatPasses: measured.filter((sample) => sample.output.formatOK).length,
      retries: measured.reduce((count, sample) => count + sample.telemetry.retryCount, 0),
      accounting: {
        completeSamples: measured.filter((sample) => sample.telemetry.accountingQuality === "complete").length,
        legacySamples: measured.filter((sample) => sample.telemetry.accountingQuality === "legacy").length,
        incompleteSamples: measured.filter((sample) => !["complete", "legacy"].includes(sample.telemetry.accountingQuality)).length,
      },
      ttftMS: distribution(valid.map((sample) => sample.metrics.ttftMS)),
      ttfatMS: distribution(valid.map((sample) => sample.metrics.ttfatMS)),
      latencyMS: distribution(valid.map((sample) => sample.metrics.latencyMS)),
      postFirstTokenTPS: distribution(valid.map((sample) => sample.metrics.postFirstTokenTPS)),
      endToEndTPS: distribution(valid.map((sample) => sample.metrics.endToEndTPS)),
      visibleCharactersPerSecond: distribution(valid.map((sample) => sample.metrics.visibleCharactersPerSecond)),
    };
  });
  agents.sort((a, b) => (b.postFirstTokenTPS.p50 ?? -1) - (a.postFirstTokenTPS.p50 ?? -1));
  const incomplete = interrupted || Boolean(aborted) || agents.some((agent) => agent.validSamples === 0);
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runID,
    fixture: { id: fixture.id, sha256: fixture.sha256 },
    seed,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    outputDirectory,
    defaults: { warmups: options.warmups, runs: options.runs, serial: true },
    interrupted,
    aborted,
    sampleCount: samples.length,
    agents,
    compareAa,
    exitCode: incomplete ? 2 : 0,
  };
}

export function formatBenchmarkMarkdown(summary) {
  const lines = [
    `# claude-all raw benchmark`,
    "",
    `Run: \`${summary.runID}\`  `,
    `Fixture: \`${summary.fixture.id}\`  `,
    `Samples: ${summary.sampleCount}  `,
    `Artifacts: \`${summary.outputDirectory}\``,
    "",
    "| Agent | Concrete route | Valid | TTFT p50/p90 | TTFAT p50/p90 | Decode tok/s p50/p90 | Wall tok/s p50/p90 | Format | Retries |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const agent of summary.agents) {
    lines.push(`| ${agent.name} | ${agent.routes.join(", ") || "—"} | ${agent.validSamples}/${agent.measuredSamples} | ${formatPair(agent.ttftMS, " ms")} | ${formatPair(agent.ttfatMS, " ms")} | ${formatPair(agent.postFirstTokenTPS)} | ${formatPair(agent.endToEndTPS)} | ${agent.formatPasses}/${agent.measuredSamples} | ${agent.retries} |`);
  }
  if (summary.interrupted) lines.push("", "Run interrupted; artifacts contain partial results.");
  if (summary.aborted) lines.push("", `Run aborted: ${summary.aborted}. Artifacts contain partial results.`);
  lines.push(
    "",
    "ttfatMS is client-wall-clock based (vs proxy-measured ttft_ms) and includes process startup — comparable across agents in one run, not directly to proxy TTFT.",
  );
  if (summary.compareAa) {
    lines.push(...formatCompareAaSection(summary));
  }
  return lines.join("\n");
}

export function loadAaCompareExtract(path, readFile = readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(String(readFile(path, "utf8")));
  } catch (error) {
    throw new Error(`could not read AA extract ${path}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.agents || typeof parsed.agents !== "object" || Array.isArray(parsed.agents)) {
    throw new Error(`invalid AA extract: ${path}`);
  }
  return parsed;
}

function formatCompareAaSection(summary) {
  const lines = [
    "",
    "## Artificial Analysis comparison",
    "",
    "| Agent | AA TTFAT (s) | Local TTFAT p50 (s) | TTFAT Δ% | AA tok/s | Local tok/s p50 | tok/s Δ% |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const agent of summary.agents) {
    const aaAgent = summary.compareAa?.agents?.[agent.name];
    const performance = aaAgent?.variants?.[0]?.performance;
    if (!performance) {
      lines.push(`| ${agent.name} | no AA data | — | — | — | — | — |`);
      continue;
    }
    const aaTtfatS = Number(performance.median_time_to_first_answer_token_seconds);
    const aaTokS = Number(performance.median_output_tokens_per_second);
    const localTtfatS = Number.isFinite(agent.ttfatMS?.p50) ? roundNumber(agent.ttfatMS.p50 / 1000) : null;
    const localTokS = Number.isFinite(agent.postFirstTokenTPS?.p50) ? agent.postFirstTokenTPS.p50 : null;
    lines.push(
      `| ${agent.name} | ${formatScalar(aaTtfatS)} | ${formatScalar(localTtfatS)} | ${formatDeltaPercent(localTtfatS, aaTtfatS)} | ${formatScalar(aaTokS)} | ${formatScalar(localTokS)} | ${formatDeltaPercent(localTokS, aaTokS)} |`,
    );
  }
  return lines;
}

function formatScalar(value) {
  return Number.isFinite(value) ? String(value) : "—";
}

function formatDeltaPercent(local, reference) {
  if (!Number.isFinite(local) || !Number.isFinite(reference) || reference === 0) return "—";
  const delta = roundNumber(((local - reference) / reference) * 100);
  return `${delta > 0 ? "+" : ""}${delta}%`;
}

// The proxy is trusted with the client key, so it must be local. Without this
// an inherited ANTHROPIC_BASE_URL would send the credential to any host.
export function assertLoopbackProxyURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`benchmark proxy URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`benchmark proxy URL must use http or https: ${value}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(
      `benchmark proxy URL must be loopback because it receives the proxy client key: ${value}`,
    );
  }
  return value;
}

async function verifyTelemetryEndpoint(baseURL, clientKey, fetchImpl, unknownID) {
  const response = await fetchImpl(`${baseURL}/v1/benchmark/usage/${unknownID}`, {
    headers: { Authorization: `Bearer ${clientKey}` },
  });
  if (response.status !== 404) {
    throw new Error(`benchmark telemetry preflight failed: expected HTTP 404, received ${response.status}`);
  }
  // A proxy without the route answers 404 with an empty body, so a bare status
  // check proves nothing; every sample would then poll the full window and time
  // out. The route's own not-found payload is the signal that it exists.
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const reported = typeof payload?.error === "string" ? payload.error.toLowerCase() : "";
  if (!reported.includes("benchmark usage")) {
    throw new Error(
      `benchmark telemetry endpoint is not implemented by the proxy at ${baseURL}: ` +
      "the unknown-id probe did not return the benchmark usage not-found payload",
    );
  }
}

async function pollBenchmarkUsage(baseURL, clientKey, benchmarkID, fetchImpl) {
  const deadline = performance.now() + 10_000;
  let delayMS = 100;
  while (true) {
    let response = null;
    try {
      response = await fetchImpl(`${baseURL}/v1/benchmark/usage/${benchmarkID}`, {
        headers: { Authorization: `Bearer ${clientKey}` },
      });
    } catch (error) {
      // A reset or refused connection is transient; fall through to the
      // backoff below and keep using the retry window.
      if (performance.now() >= deadline) {
        throw new Error(`benchmark telemetry request failed for ${benchmarkID}: ${error.message}`);
      }
    }
    if (response?.ok) {
      const payload = await response.json();
      return validateBenchmarkUsagePayload(payload, benchmarkID);
    }
    if (response && response.status !== 404) {
      throw new Error(`benchmark telemetry request failed with HTTP ${response.status}`);
    }
    if (performance.now() >= deadline) throw new Error(`timed out waiting for benchmark telemetry ${benchmarkID}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMS));
    delayMS = Math.min(1000, delayMS * 2);
  }
}

export function validateBenchmarkUsagePayload(payload, benchmarkID) {
  if (![1, PROXY_TELEMETRY_SCHEMA_VERSION].includes(payload?.schema_version) ||
      payload.benchmark_id !== benchmarkID ||
      !Array.isArray(payload.records) ||
      !payload.records.every((record) => record !== null && typeof record === "object")) {
    throw new Error(`invalid benchmark telemetry response for ${benchmarkID}`);
  }
  if (payload.schema_version === PROXY_TELEMETRY_SCHEMA_VERSION &&
      !payload.records.every(validCanonicalAccountingRecord)) {
    throw new Error(`invalid benchmark telemetry response for ${benchmarkID}`);
  }
  return payload;
}

function validCanonicalAccountingRecord(record) {
  if (record.accounting_version !== 2) return false;
  const breakdown = record.token_breakdown;
  if (!breakdown || breakdown.schema_version !== 2 ||
      !["complete", "inconsistent", "unclassified"].includes(breakdown.quality)) {
    return false;
  }
  const values = [
    breakdown.total_tokens,
    breakdown.unclassified_tokens,
    breakdown.input?.total_tokens,
    breakdown.input?.uncached_tokens,
    breakdown.input?.cache_read_tokens,
    breakdown.input?.cache_write_tokens,
    breakdown.output?.total_tokens,
    breakdown.output?.non_reasoning_tokens,
    breakdown.output?.reasoning_tokens,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  if (breakdown.input.total_tokens !== breakdown.input.uncached_tokens +
      breakdown.input.cache_read_tokens + breakdown.input.cache_write_tokens) return false;
  if (breakdown.output.total_tokens !== breakdown.output.non_reasoning_tokens +
      breakdown.output.reasoning_tokens) return false;
  if (breakdown.total_tokens !== breakdown.input.total_tokens +
      breakdown.output.total_tokens + breakdown.unclassified_tokens) return false;
  return breakdown.quality !== "complete" || breakdown.unclassified_tokens === 0;
}

function appendBenchmarkHeader(existing, benchmarkID) {
  const current = String(existing ?? "").trim();
  if (current.toLowerCase().includes(BENCHMARK_HEADER.toLowerCase())) {
    throw new Error(`${BENCHMARK_HEADER} is already present in ANTHROPIC_CUSTOM_HEADERS`);
  }
  const header = `${BENCHMARK_HEADER}: ${benchmarkID}`;
  return current ? `${current}\n${header}` : header;
}

function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

function nearestRank(sorted, percentile) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function shuffle(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

function seededRandom(seed) {
  let state = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function parseCount(value, name, allowZero) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count) || (!allowZero && count === 0)) throw new Error(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  return count;
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sanitizeError(stderr) {
  const line = String(stderr).split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  return line.slice(0, 1000);
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function nullableRound(value) {
  return value === null || value === undefined ? null : roundNumber(value);
}

function formatPair(distributionValue, suffix = "") {
  if (!distributionValue || distributionValue.p50 === null || distributionValue.p50 === undefined) return "—";
  return `${distributionValue.p50}${suffix} / ${distributionValue.p90}${suffix}`;
}

function writeJSONLine(stream, value) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => error ? rejectPromise(error) : resolvePromise());
  });
}

function closeStream(stream) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.on("error", rejectPromise);
    stream.end(resolvePromise);
  });
}
