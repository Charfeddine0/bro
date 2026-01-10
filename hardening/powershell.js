const { execFileSync, spawnSync } = require("child_process");

function ensureWindows() {
  if (process.platform !== "win32") {
    throw new Error("This action is intended for Windows only.");
  }
}

function assertAdmin() {
  const result = spawnSync("net", ["session"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error("Run this action as Administrator.");
  }
}

function runPowerShell(script) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" }
  ).trim();
}

function jsonFromPowerShell(script) {
  const output = runPowerShell(script);
  if (!output) return null;
  return JSON.parse(output);
}

module.exports = {
  ensureWindows,
  assertAdmin,
  runPowerShell,
  jsonFromPowerShell
};
