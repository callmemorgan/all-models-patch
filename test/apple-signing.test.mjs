import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_APPLE_TEAM_ID,
  PROJECT_DEVELOPER_ID_AUTHORITY,
  projectDeveloperIdCdHash,
  validateNotarizationLog,
  validateProjectDeveloperIdDetails,
} from "../src/apple-signing.mjs";

function validDetails() {
  return [
    "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+2 location=embedded",
    `Authority=${PROJECT_DEVELOPER_ID_AUTHORITY}`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "Timestamp=Jul 15, 2026 at 11:43:12 AM",
    `TeamIdentifier=${PROJECT_APPLE_TEAM_ID}`,
    "CDHash=8550c81e3b65f0219d8add37c9d40204e02b1f8c",
  ].join("\n");
}

test("accepts the pinned hardened and timestamped project Developer ID signature", () => {
  assert.equal(validateProjectDeveloperIdDetails(validDetails()), true);
});

test("rejects the wrong Developer ID authority or team", () => {
  assert.throws(
    () => validateProjectDeveloperIdDetails(validDetails().replace(PROJECT_DEVELOPER_ID_AUTHORITY, "Developer ID Application: Someone Else (AAAAAAAAAA)")),
    /project Developer ID Application certificate/,
  );
  assert.throws(
    () => validateProjectDeveloperIdDetails(validDetails().replace(`TeamIdentifier=${PROJECT_APPLE_TEAM_ID}`, "TeamIdentifier=AAAAAAAAAA")),
    /team does not match/,
  );
});

test("rejects signatures without hardened runtime or trusted timestamp", () => {
  assert.throws(() => validateProjectDeveloperIdDetails(validDetails().replace("(runtime)", "")), /hardened runtime/);
  assert.throws(() => validateProjectDeveloperIdDetails(validDetails().replace(/^Timestamp=.+\n/m, "")), /trusted timestamp/);
});

test("extracts the signed manager CDHash", () => {
  assert.equal(projectDeveloperIdCdHash(validDetails()), "8550c81e3b65f0219d8add37c9d40204e02b1f8c");
  assert.throws(() => projectDeveloperIdCdHash(validDetails().replace(/^CDHash=.+$/m, "")), /code-directory hash/);
});

test("requires a matching ARM64 manager ticket in the accepted notarization log", () => {
  const log = {
    status: "Accepted",
    statusSummary: "Ready for distribution",
    issues: null,
    ticketContents: [{
      path: "submission.zip/all-models-patch-0.5.0/bin/all-models-patch",
      arch: "arm64",
      cdhash: "8550c81e3b65f0219d8add37c9d40204e02b1f8c",
    }],
  };
  assert.equal(validateNotarizationLog(log, "8550c81e3b65f0219d8add37c9d40204e02b1f8c"), true);
  assert.throws(() => validateNotarizationLog({ ...log, ticketContents: [] }, log.ticketContents[0].cdhash), /ARM64 manager ticket/);
  assert.throws(() => validateNotarizationLog(log, "a".repeat(40)), /does not match/);
  assert.throws(() => validateNotarizationLog({ ...log, issues: [{ severity: "warning" }] }, log.ticketContents[0].cdhash), /contains issues/);
});
