import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdownIndex } from "../scripts/check-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("npm package contains its user guides, CLI auth implementation and local docs link targets", () => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = spawnSync(command, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, npm_config_loglevel: "silent" },
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.length, 1);
  const files = new Set(result[0].files.map((file) => file.path));
  for (const name of ["src/cli-auth.ts", "docs/piG-agent-shell-qualification.md", "docs/pig-compatibility.md", "docs/feature-map.md"]) {
    assert.ok(files.has(name), `Missing published file: ${name}`);
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const { links } = markdownIndex(readFileSync(resolve(root, file), "utf8"));
    for (const link of links) {
      if (link.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
      const [path] = link.split("#");
      if (!path) continue;
      const target = posix.join(posix.dirname(file), decodeURIComponent(path)).replace(/\/$/, "");
      assert.ok(files.has(target) || [...files].some(name => name.startsWith(target + "/")),
        `${file}: ${link} is not in the npm package`);
    }
  }
});
