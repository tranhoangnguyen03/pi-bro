#!/usr/bin/env node
// Release metadata validation (ci.yml) and npm/GitHub drift comparison (sync-check.yml).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const parse = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
	return m ? m.slice(1).map(Number) : null;
};

const cmp = (a, b) => {
	const [x, y] = [parse(a), parse(b)];
	if (!x || !y) return null;
	for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
};

const bump = (from, to) => {
	const [a, b] = [parse(from), parse(to)];
	if (!a || !b) return null;
	if (b[0] === a[0] + 1 && b[1] === 0 && b[2] === 0) return "major";
	if (b[0] === a[0] && b[1] === a[1] + 1 && b[2] === 0) return "minor";
	if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2] + 1) return "patch";
	return null;
};

const fail = (msg) => {
	console.error(`release check failed: ${msg}`);
	process.exit(1);
};

const readVersion = (rev) => JSON.parse(run("git", ["show", `${rev}:package.json`])).version;

// Files whose change means the published tarball changed.
const SHIPPED_FILES = ["bro.ts", "prompt.ts", "package.json", "package-lock.json"];

const publishedVersion = () => {
	try {
		return run("npm", ["view", "pi-bro", "version"]);
	} catch {
		fail("could not read pi-bro's published version from npm; check registry access");
	}
};

const mode = process.argv[2];

if (mode === "selftest") {
	const cases = [
		[cmp("1.0.0", "1.0.1"), -1],
		[cmp("1.0.1", "1.0.0"), 1],
		[cmp("1.0.0", "1.0.0"), 0],
		[bump("0.10.0", "0.10.1"), "patch"],
		[bump("0.10.0", "0.11.0"), "minor"],
		[bump("0.10.0", "1.0.0"), "major"],
		[bump("0.10.0", "0.10.0"), null],
		[bump("0.10.0", "1.1.0"), null],
		[bump("0.10.0", "0.10.3"), null],
	];
	for (const [got, want] of cases) {
		if (got !== want) fail(`selftest: got ${got}, want ${want}`);
	}
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
	const releaseLabels = labels.filter((l) => l.startsWith("release:") && l !== "release:none");
	if (labels.includes("release:none") && releaseLabels.length > 0) {
		fail(`release:none cannot be combined with ${releaseLabels.join(", ")}`);
	}
	if (releaseLabels.length > 1) fail(`multiple release labels: ${releaseLabels.join(", ")}`);

	if (cmp(next, published) === 0) {
		if (labels.includes("release:none")) {
			console.log("release:none; no release");
			process.exit(0);
		}
		const changed = run("git", ["diff", "--name-only", `${process.env.BASE_SHA}...${process.env.HEAD_SHA}`]).split("\n");
		const shipped = changed.filter((f) => SHIPPED_FILES.includes(f));
		if (shipped.length > 0) {
			fail(
				`shipped files changed (${shipped.join(", ")}) but package.json is still ${next}. ` +
					`Run "npm version patch|minor|major --no-git-tag-version", add a "## [${next}]" CHANGELOG section, ` +
					`or label the PR release:none.`,
			);
		}
		console.log("docs/CI-only change; no release");
		process.exit(0);
	}

	const level = bump(published, next);
	if (!level) fail(`${next} is not a clean patch/minor/major bump from published ${published}`);
	if (releaseLabels.length === 1 && releaseLabels[0] !== `release:${level}`) {
		fail(`label ${releaseLabels[0]} does not match the ${level} bump ${published} -> ${next}`);
	}

	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	if (lock.version !== next || lock.packages?.[""]?.version !== next) {
		fail("package-lock.json version is out of sync; run npm install");
	}
	if (!new RegExp(`^## \\[${next.replace(/\./g, "\\.")}\\]`, "m").test(readFileSync("CHANGELOG.md", "utf8"))) {
		fail(`CHANGELOG.md has no "## [${next}]" section`);
	}
	console.log(`release ${published} -> ${next} (${level})`);
} else {
	fail("usage: release-utils.mjs selftest|validate|gt <a> <b>");
}
