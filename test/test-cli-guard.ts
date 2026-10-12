// Fail closed even if a routing/validation regression reaches the wrong backend.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "bro-cli-guard-"));
const originalPath = process.env.PATH;
for (const cli of ["agy", "claude", "grok", "codex", "muse"]) {
	writeFileSync(join(directory, cli), "#!/bin/sh\necho 'Unexpected backend invocation blocked by offline tests' >&2\nexit 97\n", { mode: 0o755 });
}
process.env.PATH = `${directory}:${originalPath ?? ""}`;
after(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	rmSync(directory, { recursive: true, force: true });
});
