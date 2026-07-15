import { execFileSync, spawnSync } from "node:child_process";

export const PROJECT_APPLE_TEAM_ID = "5LTMYWRTYR";
export const PROJECT_DEVELOPER_ID_AUTHORITY = `Developer ID Application: MORGANA FAYE ALLEN (${PROJECT_APPLE_TEAM_ID})`;

export function validateProjectDeveloperIdDetails(detail) {
  if (!detail.includes(`Authority=${PROJECT_DEVELOPER_ID_AUTHORITY}`)) {
    throw new Error("manager is not signed with the project Developer ID Application certificate");
  }
  if (!detail.includes(`TeamIdentifier=${PROJECT_APPLE_TEAM_ID}`)) {
    throw new Error("manager Developer ID team does not match the project team");
  }
  if (!/^CodeDirectory .*flags=.*\(runtime\)/m.test(detail)) {
    throw new Error("manager signature does not enable the hardened runtime");
  }
  if (!/^Timestamp=.+/m.test(detail)) {
    throw new Error("manager signature does not include a trusted timestamp");
  }
  return true;
}

export function verifyProjectDeveloperIdSignature(path, { exec = execFileSync, spawn = spawnSync } = {}) {
  exec("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", path], { stdio: "pipe" });
  const result = spawn("/usr/bin/codesign", ["-d", "--verbose=4", path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`could not inspect manager code signature: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  validateProjectDeveloperIdDetails(result.stderr);
  return true;
}
