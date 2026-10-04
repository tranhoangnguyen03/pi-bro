#!/usr/bin/env node
// Release metadata validation (ci.yml) and npm/GitHub drift comparison (sync-check.yml).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
	cmp,
	classify,
	getShippedFiles,
	runSelftest,
} from "./release-rules.mjs";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const fail = (msg) => {
	console.error(`release check failed: ${msg}`);
	process.exit(1);
};

const readVersion = (rev) => JSON.parse(run("git", ["show", `${rev}:package.json`])).version;

const publishedVersion = () => {
	if (process.env.NPM_PUBLISHED_VERSION) return process.env.NPM_PUBLISHED_VERSION.trim();
	try {
		return run("npm", ["view", "pi-bro", "version"]);
	} catch {
		fail("could not read pi-bro's published version from npm; check registry access");
	}
};

const mode = process.argv[2];

if (mode === "selftest") {
	runSelftest(fail);
	console.log("selftest ok");
} else if (mode === "gt") {
	const [a, b] = process.argv.slice(3);
	const result = cmp(a, b);
	if (result === null) {
		console.error(`cannot compare versions: ${a} / ${b}`);
		process.exit(2);
	}
	process.exit(result === 1 ? 0 : 1);
} else if (mode === "validate") {
	if (!process.env.BASE_SHA || !process.env.HEAD_SHA) fail("BASE_SHA and HEAD_SHA are required");
	const published = publishedVersion();
	const next = readVersion("HEAD");
	const labels = JSON.parse(process.env.LABELS || "[]");
	const changed = run("git", ["diff", "--name-only", `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`])
		.split("\n")
		.map((f) => f.trim())
		.filter(Boolean);
	const manifest = JSON.parse(readFileSync("package.json", "utf8"));
	const shippedFiles = getShippedFiles(manifest);
	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	const changelog = readFileSync("CHANGELOG.md", "utf8");

	const res = classify({
		published,
		next,
		labels,
		changed,
		shippedFiles,
		lock,
		changelog,
	});

	if (!res.ok) fail(res.error);
	console.log(res.message);
	process.exit(0);
} else {
	fail("usage: release-utils.mjs selftest|validate|gt <a> <b>");
}
