/** Real Pi RPC host qualification. No model credentials or live providers are used. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostBinary = process.env.BRO_HOST_TEST_BIN ?? join(repo, "node_modules", ".bin", "pi");

async function until(predicate, label, timeoutMs = 8000) {
  const limit = Date.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await sleep(20);
  } while (Date.now() < limit);
  assert.fail(`Timed out waiting for ${label}`);
}

async function startHost(root) {
  const bin = join(root, "bin");
  await mkdir(bin);
  const agy = join(bin, "agy");
  await writeFile(agy, `#!/usr/bin/env node
const fs = require("node:fs");
const root = process.env.HOST_LIFECYCLE_DIR;
fs.writeFileSync(root + "/agy-argv", process.argv.slice(2).join(" "));
if (process.argv.some(arg => arg.includes("HOST_SECOND_MARKER"))) {
  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"FRESH_RESULT"}}) + "\\n");
  fs.writeFileSync(root + "/second-started", "yes");
  process.exit(0);
}
process.on("SIGTERM", () => {
  fs.writeFileSync(root + "/term-received", "yes");
  process.exit(0);
});
fs.writeFileSync(root + "/started-first", "yes");
fs.writeFileSync(root + "/child.pid", String(process.pid));
setInterval(() => {
  // A late response here would violate Bro's cancellation contract.
  fs.writeFileSync(root + "/late-result", "yes");
  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"BAD_LATE_RESULT"}}) + "\\n");
  process.exit(0);
}, 30_000);
`);
  await chmod(agy, 0o755);
  for (const name of ["claude", "grok", "codex", "muse"]) {
    const blocked = join(bin, name);
    await writeFile(blocked, "#!/bin/sh\necho Unexpected real provider call >&2\nexit 97\n");
    await chmod(blocked, 0o755);
  }
  const probe = join(root, "probe.ts");
  await writeFile(probe, `import { writeFile } from "node:fs/promises";
const root = process.env.HOST_LIFECYCLE_DIR!;
export default function (pi: any) {
  pi.registerCommand("host-qual-reload", {
    description: "Reload the real host for lifecycle qualification",
    handler: async (_args: string, ctx: any) => {
      await ctx.reload();
      await writeFile(root + "/reloaded", "ok");
    },
  });
}
`);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  // Pi does not create a session file for extension-only commands by default.
  // This fixture starts with a real session so custom results are durable.
  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, JSON.stringify({
    type: "session", version: 3, id: "00000000-0000-7000-8000-000000000071",
    timestamp: new Date().toISOString(), cwd: repo,
  }) + "\n");
  const args = ["--mode", "rpc", "--offline", "--no-extensions", "-e", join(repo, "src", "bro.ts"),
    "-e", probe, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
    "--no-themes", "--session", sessionFile];
  const child = spawn(hostBinary, args, {
    cwd: repo,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PIG_CODING_AGENT_DIR: agentDir,
      PIG_HOME: join(root, "pig-home"), PIG_USE_PI_DIRS: "0", PI_OFFLINE: "1",
      HOST_LIFECYCLE_DIR: root, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  let buffer = "";
  let nextId = 0;
  const pending = new Map();
  child.stderr.on("data", data => { stderr += data.toString("utf8"); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      stdout += line + "\n";
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      if (response.type !== "response" || !pending.has(response.id)) continue;
      const done = pending.get(response.id);
      pending.delete(response.id);
      done(response);
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child, closed, output: () => `${stderr}\n${stdout}`,
    send: message => new Promise((resolve, reject) => {
      const id = `host-${nextId++}`;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n", error => {
        if (error) { pending.delete(id); reject(error); }
      });
    }),
  };
}

async function cleanup(root, host) {
  if (host && host.child.exitCode === null) {
    host.child.kill("SIGKILL");
    await host.closed;
  }
  // An older/broken Bro may leave its detached child alive. Avoid leaking it.
  const pidFile = join(root, "child.pid");
  if (existsSync(pidFile)) {
    const pid = Number(await readFile(pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}

test("real Pi RPC reload awaits Bro cancellation, then accepts new work", { timeout: 25_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bro-host-reload-"));
  let host;
  try {
    host = await startHost(root);
    const first = host.send("/bro text HOST_FIRST_MARKER");
    await until(() => existsSync(join(root, "started-first")), "first CLI start");
    const args = await readFile(join(root, "agy-argv"), "utf8");
    assert.match(args, /(?:^|\s)--sandbox(?:\s|$)/, "restricted Explain must request the Agy sandbox");
    assert.doesNotMatch(args, /--dangerously-skip-permissions/, "restricted Explain must never bypass permission checks");
    const reload = await host.send("/host-qual-reload");
    assert.equal(reload.success, true, host.output());
    await until(() => existsSync(join(root, "reloaded")), "host reload");
    assert.equal(existsSync(join(root, "term-received")), true,
      "reload must await the old extension's actual process cleanup");
    assert.equal((await first).success, true, host.output());
    assert.equal(existsSync(join(root, "late-result")), false);
    const second = await host.send("/bro text HOST_SECOND_MARKER");
    assert.equal(second.success, true, host.output());
    assert.equal(second.data?.disposition, "handled");
    assert.equal(existsSync(join(root, "second-started")), true);
    const session = (await readFile(join(root, "session.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(session.some(entry => entry.type === "custom" && entry.customType === "bro-last-result"
      && JSON.stringify(entry.data).includes("FRESH_RESULT")),
    "the replacement Bro command must save its result in the real Pi session");
    host.child.stdin.end();
    assert.equal((await host.closed).code, 0, host.output());
  } finally { await cleanup(root, host); }
});

test("real Pi RPC EOF invokes graceful Bro cleanup", { timeout: 25_000, skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bro-host-eof-"));
  let host;
  try {
    host = await startHost(root);
    // PiG 0.5.3 may close RPC without acknowledging an interrupted extension command.
    // EOF's contract is process cleanup, not delivery of that pending acknowledgement.
    void host.send("/bro text HOST_FIRST_MARKER").catch(() => {});
    await until(() => existsSync(join(root, "started-first")), "active CLI before EOF");
    host.child.stdin.end();
    const exit = await Promise.race([host.closed,
      sleep(10_000, undefined, { ref: false }).then(() => assert.fail("EOF shutdown did not complete"))]);
    assert.equal(exit.code, 0, host.output());
    assert.equal(existsSync(join(root, "term-received")), true);
    assert.equal(existsSync(join(root, "late-result")), false);
  } finally { await cleanup(root, host); }
});
