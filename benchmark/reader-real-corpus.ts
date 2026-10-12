// Real assistant replies from pi-bro development sessions, each approved by the maintainer for
// publication. Texts live in fixtures/reader-real/; checks are frozen here.
import { readFileSync } from "node:fs";
import type { Probe, ReaderCase } from "./reader-corpus.ts";

const required = (id: string, question: string, expected: boolean): Probe => ({ id, question, expected, tier: "required" });
const compared = (id: string, question: string, expected: boolean): Probe => ({ id, question, expected, tier: "compared" });
const source = (file: string): string => readFileSync(new URL(`./fixtures/reader-real/${file}`, import.meta.url), "utf8");

export const REAL_CASES: ReaderCase[] = [
	{
		id: "R01",
		track: "explain",
		source: source("R01.md"),
		origin: "pi-bro session 2026-10-04: status report after implementing issue #94 (reader preferences)",
		probes: [
			required("not_pushed", "Does the output say the work has been pushed or that a pull request exists?", false),
			required("decision", "Does the output convey that the next step waits on the reader deciding whether to push and open a PR?", true),
			required("real_models", "Does the output present real models following the language and precedence rules as verified?", false),
			required("old_file", "Does the output say bro-prompt.md is still read?", false),
			compared("tests_passed", "Does the output report that the full test suite passed on the most recent runs?", true),
			compared("flaky", "Does the output warn that an existing test may fail intermittently in CI?", true),
		],
	},
	{
		id: "R02",
		track: "explain",
		source: source("R02.md"),
		origin: "pi-bro session 2026-09-09: diagnosis of a failed release step after a successful npm publish",
		probes: [
			required("publish_failed", "Does the output say the npm publish of 0.10.1 failed?", false),
			required("cause", "Does the output attribute the failure to npm not yet showing the just-published version (a timing race)?", true),
			required("reader_action", "Does the output say the reader must do something now to finish the 0.10.1 release?", false),
			required("functional_change", "Does the output say 0.10.1 contains functional changes to the packaged extension?", false),
			compared("retry_fix", "Does the output say the release step now keeps checking npm for up to 60 seconds?", true),
			compared("stale_branch", "Does the output mention that a fix was first branched from an outdated main and had to be rebased?", true),
		],
	},
	{
		id: "R03",
		track: "explain",
		source: source("R03.md"),
		origin: "pi-bro session 2026-10-08: Agy and Claude implementation review of Guided Review before manual review",
		probes: [
			required("implemented", "Does the output say the fixes have already been applied to the code?", false),
			required("agy_final", "Does the output present Agy's findings as complete and final?", false),
			required("verdict", "Does the output say issues 1–7 should be fixed before the reader's manual review?", true),
			required("sandbox", "Does the output say the proposed fix makes full-access execution a sandbox?", false),
			compared("tiers", "Does the output distinguish must-fix issues from should-fix issues?", true),
			compared("forged", "Does the output report that a test showed captured evidence displaying altered content?", true),
		],
	},
	{
		id: "R04",
		track: "explain",
		source: source("R04.md"),
		origin: "pi-bro session 2026-10-05: whether the SimpleEnglish project is relevant to Bro",
		probes: [
			required("adopt_skill", "Does the output recommend adopting the SimpleEnglish skill as a whole?", false),
			required("prose_only", "Does the output recommend adopting the prose-only rule (no headers, bullets, bold or tables) for Bro's explain output?", false),
			required("own_benchmark", "Does the output say changes need Bro's own benchmark run before being trusted, because the source's numbers came from different models?", true),
			required("already_done", "Does the output say the rules have already been added to Bro's prompts?", false),
			compared("jargon", "Does the output recommend defining jargon briefly the first time it appears?", true),
			compared("list_cap", "Does the output warn that list items must count toward any future length cap?", true),
		],
	},
	{
		id: "R05",
		track: "explain",
		// One redaction: the maintainer's local checkout path became /path/to/pi-bro.
		source: source("R05.md"),
		origin: "pi-bro session 2026-10-08: manual test instructions for an early Guided Review build",
		probes: [
			required("disposable", "Does the output tell the reader to run the test from a disposable/temporary directory rather than their normal workspace?", true),
			required("real_calls", "Does the output convey that generating guides and asking questions makes real backend calls?", true),
			required("auto_generate", "Does the output say opening the PR automatically generates a guide?", false),
			required("unimplemented", "Does the output tell the reader to test notes, branch review, update review or publication?", false),
			compared("canary", "Does the output have the reader confirm afterwards that canary.txt still contains \"Leave this file unchanged\"?", true),
			compared("report_back", "Does the output ask the reader to report backend/model, terminal size, steps, expected vs actual behavior, and a screenshot or error text?", true),
		],
	},
];
