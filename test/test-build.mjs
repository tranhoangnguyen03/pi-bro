// Isolate every test-file process, but load the exact TypeScript files shipped to Pi.
import "./test-cli-guard.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

export const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const sourceDir = join(repoDir, "src");
export const buildDir = mkdtempSync(join(tmpdir(), "pi-bro-test-"));
const previousTmp = process.env.TMPDIR;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.TMPDIR = join(buildDir, "tmp");
mkdirSync(process.env.TMPDIR);
process.env.PI_CODING_AGENT_DIR = join(buildDir, "agent");
after(() => {
	if (previousTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previousTmp;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(buildDir, { recursive: true, force: true });
});

export const bro = await import("../src/bro.ts");
export const backend = await import("../src/backend.ts");
export const settings = await import("../src/settings.ts");
export const sources = await import("../src/sources.ts");
export const configUi = await import("../src/config-ui.ts");
export const util = await import("../src/util.ts");
export const doctor = await import("../src/doctor.ts");
export const show = await import("../src/show.ts");
export const advisor = await import("../src/advisor.ts");
export const btw = await import("../src/btw.ts");
export const elevate = await import("../src/elevate.ts");
export const explainModal = await import("../src/explain-modal.ts");
