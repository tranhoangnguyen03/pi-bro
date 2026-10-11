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
];

export const realSource = (c: RealCase): string =>
	readFileSync(new URL(`./fixtures/reader-real/${c.file}`, import.meta.url), "utf8");
