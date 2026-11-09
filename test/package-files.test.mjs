import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm package contains the PiG qualification report and CLI auth implementation", () => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = spawnSync(command, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.length, 1);
  const files = new Set(result[0].files.map((file) => file.path));
  for (const name of ["src/cli-auth.ts", "docs/piG-agent-shell-qualification.md", "docs/pig-compatibility.md"]) {
    assert.ok(files.has(name), `Missing published file: ${name}`);
  }
});
