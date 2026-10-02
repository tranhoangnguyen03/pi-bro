// Pure release validation rules and classification engine.
// Decoupled from CLI dispatch and environment access for offline testing.

export const parse = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
	return m ? m.slice(1).map(Number) : null;
};

export const cmp = (a, b) => {
	const [x, y] = [parse(a), parse(b)];
	if (!x || !y) return null;
	for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
};

export const bump = (from, to) => {
	const [a, b] = [parse(from), parse(to)];
	if (!a || !b) return null;
	if (b[0] === a[0] + 1 && b[1] === 0 && b[2] === 0) return "major";
	if (b[0] === a[0] && b[1] === a[1] + 1 && b[2] === 0) return "minor";
	if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2] + 1) return "patch";
	return null;
};

export const normalizePath = (p) => (p ?? "").replace(/^\.\//, "").trim();

const DOC_AND_LEGAL_EXACT = new Set([
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
	"THIRD_PARTY_NOTICES.md",
]);

export const isDocOrLegal = (file) => {
	const norm = normalizePath(file);
	if (DOC_AND_LEGAL_EXACT.has(norm)) return true;
	// Match markdown files strictly under docs/
	if (/^docs\/[^/].*\.md$/i.test(norm)) return true;
	return false;
};

export const getShippedFiles = (manifest) => {
	const files = manifest?.files;
	if (!Array.isArray(files) || files.length === 0) {
		throw new Error("package.json must contain a non-empty 'files' array");
	}
	for (const entry of files) {
		if (/[*?[\]{}!]/.test(entry)) {
			throw new Error(`unsupported pattern in package.json files: ${entry}`);
		}
	}
	const runtimeEntries = files
		.map(normalizePath)
		.filter((f) => !isDocOrLegal(f));
	return [...runtimeEntries, "package.json", "package-lock.json"];
};

export const isShippedFile = (file, shippedFiles) => {
	const norm = normalizePath(file);
	return shippedFiles.some((shipped) =>
		shipped.endsWith("/") ? norm.startsWith(shipped) : norm === shipped,
	);
};

export const classify = ({
	published,
	next,
	labels = [],
	changed = [],
	shippedFiles = [],
	lock = null,
	changelog = "",
}) => {
	const releaseLabels = labels.filter((l) => l.startsWith("release:") && l !== "release:none");
	const hasNone = labels.includes("release:none");

	if (hasNone && releaseLabels.length > 0) {
		return { ok: false, error: `release:none cannot be combined with ${releaseLabels.join(", ")}` };
	}
	if (hasNone && cmp(next, published) !== 0) {
		return {
			ok: false,
			error: `release:none but package.json is ${next} (published ${published}); remove the label or the bump`,
		};
	}
	if (releaseLabels.length > 1) {
		return { ok: false, error: `multiple release labels: ${releaseLabels.join(", ")}` };
	}

	if (cmp(next, published) === 0) {
		if (releaseLabels.length > 0) {
			return {
				ok: false,
				error: `label ${releaseLabels[0]} cannot be used when package.json version ${next} matches published ${published}`,
			};
		}
		if (hasNone) {
			return { ok: true, action: "none", message: "release:none; no release" };
		}
		const shippedChanged = changed
			.map(normalizePath)
			.filter((f) => isShippedFile(f, shippedFiles));
		if (shippedChanged.length > 0) {
			return {
				ok: false,
				error:
					`shipped files changed (${shippedChanged.join(", ")}) but package.json is still ${next}. ` +
					`Run "npm version patch|minor|major --no-git-tag-version", add a "## [X.Y.Z]" CHANGELOG section for the new version, ` +
					`or label the PR release:none.`,
			};
		}
		return { ok: true, action: "none", message: "docs/CI-only change; no release" };
	}

	const level = bump(published, next);
	if (!level) {
		return { ok: false, error: `${next} is not a clean patch/minor/major bump from published ${published}` };
	}
	if (releaseLabels.length === 1 && releaseLabels[0] !== `release:${level}`) {
		return { ok: false, error: `label ${releaseLabels[0]} does not match the ${level} bump ${published} -> ${next}` };
	}

	if (!lock || typeof lock !== "object") {
		return { ok: false, error: "package-lock.json is required for release validation" };
	}
	if (lock.version !== next || lock.packages?.[""]?.version !== next) {
		return { ok: false, error: "package-lock.json version is out of sync; run npm install" };
	}

	if (!new RegExp(`^## \\[${next.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
		return { ok: false, error: `CHANGELOG.md has no "## [${next}]" section` };
	}

	return { ok: true, action: "release", level, message: `release ${published} -> ${next} (${level})` };
};

export const runSelftest = (fail = (msg) => { throw new Error(msg); }) => {
	// 1. Version arithmetic
	const arithmeticCases = [
		[cmp("1.0.0", "1.0.1"), -1],
		[cmp("1.0.1", "1.0.0"), 1],
		[cmp("1.0.0", "1.0.0"), 0],
		[bump("0.10.0", "0.10.1"), "patch"],
		[bump("0.10.0", "0.11.0"), "minor"],
		[bump("0.10.0", "1.0.0"), "major"],
		[bump("0.10.0", "0.10.0"), null],
		[bump("0.10.0", "1.1.0"), null],
		[bump("0.10.0", "0.10.3"), null],
		[bump("0.10.1", "0.10.0"), null],
	];
	for (const [got, want] of arithmeticCases) {
		if (got !== want) fail(`selftest arithmetic: got ${got}, want ${want}`);
	}

	// 2. Doc/legal boundary tests
	if (!isDocOrLegal("README.md")) fail("README.md must be doc");
	if (!isDocOrLegal("./CHANGELOG.md")) fail("./CHANGELOG.md must be doc");
	if (!isDocOrLegal("docs/pig-compatibility.md")) fail("docs/pig-compatibility.md must be doc");
	if (isDocOrLegal("docs/runtime.ts")) fail("docs/runtime.ts must NOT be doc");
	if (isDocOrLegal("README-loader.ts")) fail("README-loader.ts must NOT be doc");
	if (isDocOrLegal("changelog-parser.ts")) fail("changelog-parser.ts must NOT be doc");
	if (isDocOrLegal("LICENSE-validator.js")) fail("LICENSE-validator.js must NOT be doc");

	// 3. Shipped files derivation & rejection tests
	try {
		getShippedFiles({});
		fail("getShippedFiles must throw on missing files");
	} catch (e) {
		if (!/non-empty 'files' array/.test(e.message)) throw e;
	}
	for (const badPattern of ["*.ts", "lib/?", "src/[a-z].ts", "{a,b}.ts", "!ignored.ts"]) {
		try {
			getShippedFiles({ files: [badPattern] });
			fail(`getShippedFiles must throw on pattern: ${badPattern}`);
		} catch (e) {
			if (!/unsupported pattern/.test(e.message)) throw e;
		}
	}

	const sampleManifest = {
		files: [
			"./bro.ts",
			"ui-capabilities.ts",
			"backend.ts",
			"prompt.ts",
			"extra-runtime.json",
			"docs/runtime.ts",
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
			"THIRD_PARTY_NOTICES.md",
			"docs/pig-compatibility.md",
		],
	};
	const derived = getShippedFiles(sampleManifest);
	const expected = [
		"bro.ts",
		"ui-capabilities.ts",
		"backend.ts",
		"prompt.ts",
		"extra-runtime.json",
		"docs/runtime.ts",
		"package.json",
		"package-lock.json",
	];
	if (JSON.stringify(derived) !== JSON.stringify(expected)) {
		fail(`selftest getShippedFiles: got ${JSON.stringify(derived)}, want ${JSON.stringify(expected)}`);
	}

	// 4. Offline classification matrix
	const standardLock = { version: "0.19.6", packages: { "": { version: "0.19.6" } } };
	const standardChangelog = "## [0.19.6] - 2026-10-02\n- Test release";
	const shippedFiles = derived;

	const classifyCases = [
		// Label conflicts
		{
			desc: "release:none with release:patch label",
			input: { published: "0.19.5", next: "0.19.5", labels: ["release:none", "release:patch"] },
			want: { ok: false, errorMatch: /cannot be combined/ },
		},
		{
			desc: "multiple release labels",
			input: { published: "0.19.5", next: "0.19.6", labels: ["release:patch", "release:minor"] },
			want: { ok: false, errorMatch: /multiple release labels/ },
		},
		{
			desc: "release:none with version bump",
			input: { published: "0.19.5", next: "0.19.6", labels: ["release:none"] },
			want: { ok: false, errorMatch: /release:none but package\.json is 0\.19\.6/ },
		},
		{
			desc: "release label on equal version",
			input: { published: "0.19.5", next: "0.19.5", labels: ["release:patch"], changed: ["README.md"] },
			want: { ok: false, errorMatch: /label release:patch cannot be used when package\.json version 0\.19\.5 matches published 0\.19\.5/ },
		},
		// Equal version
		{
			desc: "equal version with release:none",
			input: { published: "0.19.5", next: "0.19.5", labels: ["release:none"], changed: ["bro.ts"], shippedFiles },
			want: { ok: true, action: "none" },
		},
		{
			desc: "equal version with docs/test change only",
			input: { published: "0.19.5", next: "0.19.5", changed: ["README.md", "docs/pig-compatibility.md", "backend.test.ts"], shippedFiles },
			want: { ok: true, action: "none" },
		},
		{
			desc: "ACCEPTANCE: equal version with ui-capabilities.ts changed",
			input: { published: "0.19.5", next: "0.19.5", changed: ["ui-capabilities.ts"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(ui-capabilities\.ts\)/ },
		},
		{
			desc: "equal version with extra-runtime.json (fail-closed check)",
			input: { published: "0.19.5", next: "0.19.5", changed: ["extra-runtime.json"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(extra-runtime\.json\)/ },
		},
		{
			desc: "equal version with docs/runtime.ts changed (ensures docs/ code is not excluded)",
			input: { published: "0.19.5", next: "0.19.5", changed: ["docs/runtime.ts"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(docs\/runtime\.ts\)/ },
		},
		{
			desc: "equal version with package.json changed",
			input: { published: "0.19.5", next: "0.19.5", changed: ["package.json"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(package\.json\)/ },
		},
		{
			desc: "equal version with package-lock.json changed",
			input: { published: "0.19.5", next: "0.19.5", changed: ["package-lock.json"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(package-lock\.json\)/ },
		},
		{
			desc: "equal version with multiple shipped files changed",
			input: { published: "0.19.5", next: "0.19.5", changed: ["bro.ts", "backend.ts"], shippedFiles },
			want: { ok: false, errorMatch: /shipped files changed \(bro\.ts, backend\.ts\)/ },
		},
		// Release bumps
		{
			desc: "unclean bump 0.19.5 -> 0.19.7",
			input: { published: "0.19.5", next: "0.19.7", shippedFiles, lock: standardLock, changelog: standardChangelog },
			want: { ok: false, errorMatch: /not a clean patch\/minor\/major bump/ },
		},
		{
			desc: "downgrade 0.19.5 -> 0.19.4",
			input: { published: "0.19.5", next: "0.19.4", shippedFiles, lock: standardLock, changelog: standardChangelog },
			want: { ok: false, errorMatch: /not a clean patch\/minor\/major bump/ },
		},
		{
			desc: "bump label mismatch",
			input: { published: "0.19.5", next: "0.19.6", labels: ["release:minor"], shippedFiles, lock: standardLock, changelog: standardChangelog },
			want: { ok: false, errorMatch: /label release:minor does not match the patch bump/ },
		},
		{
			desc: "missing lockfile",
			input: { published: "0.19.5", next: "0.19.6", shippedFiles, lock: null, changelog: standardChangelog },
			want: { ok: false, errorMatch: /package-lock\.json is required/ },
		},
		{
			desc: "lockfile version out of sync",
			input: { published: "0.19.5", next: "0.19.6", shippedFiles, lock: { version: "0.19.5", packages: { "": { version: "0.19.6" } } }, changelog: standardChangelog },
			want: { ok: false, errorMatch: /package-lock\.json version is out of sync/ },
		},
		{
			desc: "lockfile packages root out of sync",
			input: { published: "0.19.5", next: "0.19.6", shippedFiles, lock: { version: "0.19.6", packages: { "": { version: "0.19.5" } } }, changelog: standardChangelog },
			want: { ok: false, errorMatch: /package-lock\.json version is out of sync/ },
		},
		{
			desc: "missing changelog section",
			input: { published: "0.19.5", next: "0.19.6", shippedFiles, lock: standardLock, changelog: "## [0.19.5]" },
			want: { ok: false, errorMatch: /CHANGELOG\.md has no "## \[0\.19\.6\]" section/ },
		},
		{
			desc: "valid clean patch release",
			input: { published: "0.19.5", next: "0.19.6", labels: ["release:patch"], shippedFiles, lock: standardLock, changelog: standardChangelog },
			want: { ok: true, action: "release", level: "patch" },
		},
		{
			desc: "valid clean patch release without label",
			input: { published: "0.19.5", next: "0.19.6", labels: [], shippedFiles, lock: standardLock, changelog: standardChangelog },
			want: { ok: true, action: "release", level: "patch" },
		},
		{
			desc: "valid clean minor release",
			input: { published: "0.19.5", next: "0.20.0", labels: ["release:minor"], shippedFiles, lock: { version: "0.20.0", packages: { "": { version: "0.20.0" } } }, changelog: "## [0.20.0] - 2026-10-02" },
			want: { ok: true, action: "release", level: "minor" },
		},
		{
			desc: "valid clean major release",
			input: { published: "0.19.5", next: "1.0.0", labels: ["release:major"], shippedFiles, lock: { version: "1.0.0", packages: { "": { version: "1.0.0" } } }, changelog: "## [1.0.0] - 2026-10-02" },
			want: { ok: true, action: "release", level: "major" },
		},
	];

	for (const { desc, input, want } of classifyCases) {
		const got = classify(input);
		if (got.ok !== want.ok) {
			fail(`selftest classify [${desc}]: got ok=${got.ok}, want ok=${want.ok} (message: ${got.error || got.message})`);
		}
		if (want.action && got.action !== want.action) {
			fail(`selftest classify [${desc}]: got action=${got.action}, want action=${want.action}`);
		}
		if (want.level && got.level !== want.level) {
			fail(`selftest classify [${desc}]: got level=${got.level}, want level=${want.level}`);
		}
		if (want.errorMatch && !want.errorMatch.test(got.error ?? "")) {
			fail(`selftest classify [${desc}]: error "${got.error}" does not match ${want.errorMatch}`);
		}
	}
};
