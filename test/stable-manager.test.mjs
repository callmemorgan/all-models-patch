import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  briefStatus,
  fetchStableDescriptor,
  managerPaths,
  readManagerState,
  reconcileStable,
} from "../src/stable-manager.mjs";

test("validates the Stable pointer and darwin-arm64 manifest", async () => {
  const responses = new Map([
    ["https://example.invalid/releases/stable", new Response("2.1.201\n")],
    ["https://example.invalid/releases/2.1.201/manifest.json", new Response(JSON.stringify({ platforms: { "darwin-arm64": { size: 123, checksum: "a".repeat(64) } } }))],
  ]);
  const descriptor = await fetchStableDescriptor({
    releasesUrl: "https://example.invalid/releases",
    fetchImpl: async (url) => responses.get(url) ?? new Response("missing", { status: 404 }),
  });
  assert.equal(descriptor.stableVersion, "2.1.201");
  assert.equal(descriptor.platform.size, 123);
});

test("consumer checks do not download unsupported Stable binaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-home-"));
  const toolRoot = join(home, "tool");
  const paths = managerPaths(home, join(home, "state"));
  mkdirSync(join(toolRoot, "support"), { recursive: true });
  writeFileSync(join(toolRoot, "support", "catalog.json"), JSON.stringify({ schemaVersion: 1, releaseSequence: 1, managerVersion: "0.2.0", packs: [] }));
  const pinned = join(paths.stockRoot, "versions", "2.1.197");
  mkdirSync(pinned, { recursive: true });
  symlinkSync(pinned, join(paths.stockRoot, "current"));
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith("/stable")) return new Response("2.1.201");
    if (url.endsWith("/manifest.json")) return new Response(JSON.stringify({ platforms: { "darwin-arm64": { size: 123, checksum: "a".repeat(64) } } }));
    return new Response("unexpected binary download", { status: 500 });
  };
  const state = await reconcileStable({
    toolRoot,
    paths,
    releasesUrl: "https://example.invalid/releases",
    fetchImpl,
    notify: () => true,
    quiet: true,
  });
  assert.equal(state.result.status, "unsupported");
  assert.equal(state.pinnedVersion, "2.1.197");
  assert.equal(requested.some((url) => url.endsWith("/claude")), false);
  assert.equal(readManagerState(paths).stableVersion, "2.1.201");
  assert.match(briefStatus(state), /maintainer|unsupported/);
});

test("malformed checks preserve failure state and fail closed", async () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-failure-"));
  const toolRoot = join(home, "tool");
  const paths = managerPaths(home, join(home, "state"));
  mkdirSync(join(toolRoot, "support"), { recursive: true });
  writeFileSync(join(toolRoot, "support", "catalog.json"), JSON.stringify({ schemaVersion: 1, releaseSequence: 1, managerVersion: "0.2.0", packs: [] }));
  await assert.rejects(
    reconcileStable({
      toolRoot,
      paths,
      releasesUrl: "https://example.invalid/releases",
      fetchImpl: async () => new Response("not-a-version"),
      notify: () => true,
      quiet: true,
    }),
    /invalid version/,
  );
  assert.equal(readManagerState(paths).consecutiveFailures, 1);
});
