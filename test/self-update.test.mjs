import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acceptedReleaseFloor, maybeSelfUpdate, recordAcceptedReleaseSequence } from "../src/self-update.mjs";
import { managerPaths, readManagerState, writeManagerState } from "../src/stable-manager.mjs";

test("installed catalog sequence remains the anti-rollback floor without state", () => {
  assert.equal(acceptedReleaseFloor(null, 7), 7);
  assert.equal(acceptedReleaseFloor({ highestAcceptedReleaseSequence: 9 }, 7), 9);
  assert.throws(() => acceptedReleaseFloor({ highestAcceptedReleaseSequence: "9" }, 7), /persisted release sequence is invalid/);
});

test("signed release acceptance is persisted independently of Stable reconciliation", () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-acceptance-"));
  const paths = managerPaths(home, join(home, "state"));
  writeManagerState(paths, { consecutiveFailures: 2, highestAcceptedReleaseSequence: 4 });
  recordAcceptedReleaseSequence(paths, 6);
  const state = readManagerState(paths);
  assert.equal(state.highestAcceptedReleaseSequence, 6);
  assert.equal(state.consecutiveFailures, 2);
  recordAcceptedReleaseSequence(paths, 5);
  assert.equal(readManagerState(paths).highestAcceptedReleaseSequence, 6);
});

test("self-update rejects downgrade against the installed catalog and persists accepted manifests", async () => {
  const home = mkdtempSync(join(tmpdir(), "all-models-patch-self-update-"));
  const paths = managerPaths(home, join(home, "state"));
  const baseManifest = {
    schemaVersion: 1,
    releaseSequence: 7,
    managerVersion: "0.2.0",
    sourceCommit: "a".repeat(40),
    assets: { bundle: { name: "bundle.tar.gz", sha256: "b".repeat(64), size: 1 } },
  };
  const fetchImpl = async () => new Response("fixture");

  await assert.rejects(
    maybeSelfUpdate({
      toolRoot: join(home, "tool"),
      currentVersion: "0.2.0",
      currentSequence: 7,
      paths,
      fetchImpl,
      force: true,
      verifyManifest: () => ({ ...baseManifest, releaseSequence: 6, managerVersion: "0.1.0" }),
    }),
    /replay detected/,
  );
  assert.equal(readManagerState(paths), null);

  const result = await maybeSelfUpdate({
    toolRoot: join(home, "tool"),
    currentVersion: "0.2.0",
    currentSequence: 7,
    paths,
    fetchImpl,
    force: true,
    verifyManifest: () => baseManifest,
  });
  assert.equal(result.updated, false);
  assert.equal(readManagerState(paths).highestAcceptedReleaseSequence, 7);
});
