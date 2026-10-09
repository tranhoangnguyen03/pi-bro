import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// @ts-ignore Pure release validation rules module
import { getShippedFiles, isShippedFile, classify, isDocOrLegal } from "./.github/scripts/release-rules.mjs";

const repoDir = dirname(fileURLToPath(import.meta.url));

export function collectLocalImports(
	entryPoints: string[],
	rootDir: string,
	readFileFn: (path: string) => string = (p) => readFileSync(p, "utf8"),
): Set<string> {
	const visited = new Set<string>();
	const queue = [...entryPoints];
	const localModules = new Set<string>();

	// Matches:
	// - import ... from "./..." or '../...'
	// - export ... from "./..." or '../...'
	// - import("./...") or import('../...')
	// - import "./..." or import '../...'
	const importRegex = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

	while (queue.length > 0) {
		const rel = queue.pop()!;
		const norm = relative(rootDir, resolve(rootDir, rel));
		if (visited.has(norm)) continue;
		visited.add(norm);
		localModules.add(norm);

		const fullPath = resolve(rootDir, norm);
		let content = "";
		try {
			content = readFileFn(fullPath);
		} catch {
			continue;
		}

		for (const match of content.matchAll(importRegex)) {
			const specifier = match[1] ?? match[2];
			if (specifier && specifier.startsWith(".")) {
				const targetFullPath = resolve(dirname(fullPath), specifier);
				const targetRel = relative(rootDir, targetFullPath);
				if (!visited.has(targetRel)) {
					queue.push(targetRel);
				}
			}
		}
	}

	return localModules;
}

test("collectLocalImports resolves nested relative paths and cycles accurately", () => {
	const virtualFiles = new Map<string, string>([
		["root.ts", 'import "./nested/a.ts"; import "./cycle-a.ts";'],
		["nested/a.ts", 'import "./b.ts"; export { x } from "../shared.ts";'],
		["nested/b.ts", 'await import("../dynamic.ts");'],
		["shared.ts", "// shared leaf"],
		["dynamic.ts", "// dynamic leaf"],
		["cycle-a.ts", 'import "./cycle-b.ts";'],
		["cycle-b.ts", 'import "./cycle-a.ts";'],
	]);

	const result = collectLocalImports(["./root.ts"], "/virtual", (p) => {
		const rel = relative("/virtual", p);
		const content = virtualFiles.get(rel);
		if (content === undefined) throw new Error(`file not found: ${rel}`);
		return content;
	});

	assert.deepEqual(
		Array.from(result).sort(),
		[
			"cycle-a.ts",
			"cycle-b.ts",
			"dynamic.ts",
			"nested/a.ts",
			"nested/b.ts",
			"root.ts",
			"shared.ts",
		].sort(),
	);
});

test("package.json files declares every locally imported module from pi.extensions", () => {
	const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	const entryPoints: string[] = manifest.pi?.extensions ?? ["./bro.ts"];
	const localImports = collectLocalImports(entryPoints, repoDir);

	const declaredFiles = new Set((manifest.files ?? []).map((f: string) => f.replace(/^\.\//, "")));
	const shippedFiles = getShippedFiles(manifest);

	for (const mod of localImports) {
		assert.ok(
			declaredFiles.has(mod),
			`imported module ${mod} must be declared in package.json files array`,
		);
		assert.ok(
			isShippedFile(mod, shippedFiles),
			`imported module ${mod} must be classified as shipped by release-rules`,
		);
	}
});

test("isShippedFile matches exact files and bare/trailing-slash directory descendants", () => {
	const shipped = ["bro.ts", "lib", "dist/"];
	assert.equal(isShippedFile("bro.ts", shipped), true);
	assert.equal(isShippedFile("bro.ts.map", shipped), false);
	assert.equal(isShippedFile("lib/runtime.json", shipped), true);
	assert.equal(isShippedFile("lib/sub/deep.ts", shipped), true);
	assert.equal(isShippedFile("lib-other.ts", shipped), false);
	assert.equal(isShippedFile("dist/bundle.js", shipped), true);
	assert.equal(isShippedFile("dist-other.js", shipped), false);
});

test("every non-documentation entry in package.json files requires a release", () => {
	const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	const shippedFiles = getShippedFiles(manifest);

	for (const entry of manifest.files) {
		const norm = entry.replace(/^\.\//, "");
		if (isDocOrLegal(norm)) {
			// Documentation and legal entries must not be classified as shipped triggers
			assert.equal(
				isShippedFile(norm, shippedFiles),
				false,
				`doc/legal file ${norm} must NOT trigger a required release`,
			);
		} else {
			// Runtime code and other package contents must trigger release classification
			assert.ok(
				isShippedFile(norm, shippedFiles),
				`runtime file ${norm} must be classified as a shipped trigger`,
			);
		}
	}

	// package.json and package-lock.json must also be shipped triggers
	assert.ok(isShippedFile("package.json", shippedFiles));
	assert.ok(isShippedFile("package-lock.json", shippedFiles));
});

test("classify() requires version bump or release:none for every declared runtime module", () => {
	const manifest = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
	const shippedFiles = getShippedFiles(manifest);

	for (const file of shippedFiles) {
		// Attempting an unbumped commit with this file changed without release:none must fail
		const unbumped = classify({
			published: "0.19.5",
			next: "0.19.5",
			changed: [file],
			shippedFiles,
		});
		assert.equal(unbumped.ok, false, `file ${file} must fail without version bump`);
		assert.match(unbumped.error, /shipped files changed/);

		// With release:none, it must pass
		const withNone = classify({
			published: "0.19.5",
			next: "0.19.5",
			labels: ["release:none"],
			changed: [file],
			shippedFiles,
		});
		assert.equal(withNone.ok, true, `file ${file} must pass with release:none`);
		assert.equal(withNone.action, "none");
	}
});
