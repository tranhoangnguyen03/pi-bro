// Real assistant replies from pi-bro development sessions, each approved by the maintainer for
// publication. Texts live in fixtures/reader-real/; checks are frozen here.
import { readFileSync } from "node:fs";
import type { Probe } from "./reader-corpus.ts";

export type RealCase = {
	id: string;
	track: "explain" | "btw";
	file: string;
	question?: string;
	origin: string;
	probes: Probe[];
	faithfulLiterals: string[];
};

const required = (id: string, question: string, expected: boolean): Probe => ({ id, question, expected, tier: "required" });
const compared = (id: string, question: string, expected: boolean): Probe => ({ id, question, expected, tier: "compared" });

export const REAL_CASES: RealCase[] = [
	{
		id: "R01",
		track: "explain",
		file: "R01.md",
		origin: "pi-bro session 2026-10-04: status report after implementing issue #94 (reader preferences)",
		probes: [
			required("not_pushed", "Does the output say the work has been pushed or that a pull request exists?", false),
			required("decision", "Does the output convey that the next step waits on the reader deciding whether to push and open a PR?", true),
			required("real_models", "Does the output present real models following the language and precedence rules as verified?", false),
			required("old_file", "Does the output say bro-prompt.md is still read?", false),
			compared("tests_passed", "Does the output report that the full test suite passed on the most recent runs?", true),
			compared("flaky", "Does the output warn that an existing test may fail intermittently in CI?", true),
		],
		faithfulLiterals: ["c2ed95e", "feat/issue-94-preferences", ".worktrees/issue-94", "bro-preferences.md", "bro-prompt.md", "4,000", "241/241", "0.21.0", "/bro preferences", "docs/TESTING.md"],
	},
	{
		id: "R02",
		track: "explain",
		file: "R02.md",
		origin: "pi-bro session 2026-09-09: diagnosis of a failed release step after a successful npm publish",
		probes: [
			required("publish_failed", "Does the output say the npm publish of 0.10.1 failed?", false),
			required("cause", "Does the output attribute the failure to npm not yet showing the just-published version (a timing race)?", true),
			required("reader_action", "Does the output say the reader must do something now to finish the 0.10.1 release?", false),
			required("functional_change", "Does the output say 0.10.1 contains functional changes to the packaged extension?", false),
			compared("retry_fix", "Does the output say the release step now keeps checking npm for up to 60 seconds?", true),
			compared("stale_branch", "Does the output mention that a fix was first branched from an outdated main and had to be rebased?", true),
		],
		faithfulLiterals: ["npm publish", "07:44:44", "npm view", "npm does not have 0.10.1; not creating a GitHub release", "exit code 1", "287495d", "60s", "v0.10.1", "package-lock.json", "compare/v0.10.0...v0.10.1"],
	},
];

export const realSource = (c: RealCase): string =>
	readFileSync(new URL(`./fixtures/reader-real/${c.file}`, import.meta.url), "utf8");
