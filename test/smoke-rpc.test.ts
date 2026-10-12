import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A deliberately delayed host proves mutations follow responses, not producer timing.
test("smoke RPC orders file mutations between acknowledged requests", async () => {
	const root = await mkdtemp(join(tmpdir(), "bro-rpc-test-"));
	try {
		const settings = join(root, "settings.json");
		const snapshot = join(root, "snapshot.json");
		const host = join(root, "host.mjs");
		await writeFile(settings, "old");
		await writeFile(host, `import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 setTimeout(() => {
  const text=readFileSync(${JSON.stringify(settings)},'utf8');
  if(request.id==='first') writeFileSync(${JSON.stringify(settings)},'saved');
  console.log(JSON.stringify({type:'response',id:request.id,success:true,text}));
 },100);
});`);
		const child = spawn(process.execPath, ["smoke-rpc.mjs", host], {
			cwd: import.meta.dirname,
			env: { ...process.env, BRO_SMOKE_PI_BIN: process.execPath },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "", stderr = "";
		child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.on("data", chunk => { stderr += chunk; });
		const closed = new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		child.stdin.end([
			{ id: "first", type: "prompt" },
			{ type: "smoke-copy", from: settings, to: snapshot },
			{ type: "smoke-write", path: settings, text: "new" },
			{ id: "second", type: "prompt" },
		].map(value => JSON.stringify(value)).join("\n") + "\n");
		assert.equal(await closed, 0, stderr);
		assert.deepEqual(stdout.trim().split("\n").map(line => JSON.parse(line).text), ["old", "new"]);
		assert.equal(await readFile(snapshot, "utf8"), "saved");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
