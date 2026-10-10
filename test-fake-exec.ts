// Shared temporary binary harness for offline CLI tests.
import "./test-cli-guard.ts";
import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withFakeExecutables(
	scripts: Record<string, string>,
	run: (binDir: string) => Promise<void>,
	options?: { env?: Record<string, string> },
): Promise<void> {
	const originalPath = process.env.PATH;
	const originalBinDir = process.env.BIN_DIR;
	const savedEnv: Record<string, string | undefined> = {};
	if (options?.env) {
		for (const key of Object.keys(options.env)) {
			savedEnv[key] = process.env[key];
		}
	}

	const binDir = await mkdtemp(join(tmpdir(), "pi-bro-fake-bin-"));

	try {
		for (const [name, script] of Object.entries(scripts)) {
			const binaryPath = join(binDir, name);
			await writeFile(binaryPath, script);
			chmodSync(binaryPath, 0o755);
		}

		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.BIN_DIR = binDir;
		if (options?.env) {
			for (const [key, value] of Object.entries(options.env)) process.env[key] = value;
		}

		await run(binDir);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;

		if (originalBinDir === undefined) delete process.env.BIN_DIR;
		else process.env.BIN_DIR = originalBinDir;

		if (options?.env) {
			for (const [key, prevVal] of Object.entries(savedEnv)) {
				if (prevVal === undefined) delete process.env[key];
				else process.env[key] = prevVal;
			}
		}
		await rm(binDir, { recursive: true, force: true });
	}
}

export const withFakeExecutable = (
	name: string,
	script: string,
	run: (binDir: string) => Promise<void>,
): Promise<void> => withFakeExecutables({ [name]: script }, run);
