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
		faithfulLiterals: ["c2ed95e", "feat/issue-94-preferences", ".worktrees/issue-94", "bro-preferences.md", "bro-prompt.md", "4,000", "241/241", "0.21.0", "/bro preferences", "docs/TESTING.md"],
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
		faithfulLiterals: ["npm publish", "07:44:44", "npm view", "npm does not have 0.10.1; not creating a GitHub release", "exit code 1", "287495d", "60s", "v0.10.1", "package-lock.json", "compare/v0.10.0...v0.10.1"],
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
		faithfulLiterals: ["review-source.ts:59", "review.ts:77–81", "review-source.ts:52", "review.ts:25–29", "review-modal.ts:256", "review-modal.ts:310–312", "bro.ts:361–365", "readEvidence", "listReviews", "overview:reading:", "503", "20 passed"],
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
		faithfulLiterals: ["evals/results/WHY-USELESS-2026-09-02.md", "prompt.ts:103", "prompt.ts:20-24", "benchmark/run.ts", "npm run benchmark:dry-run", "32 calls", "Claude Sonnet 4.6", "idempotent (safe to run twice)"],
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
		faithfulLiterals: ["mktemp -d /tmp/bro-guided-review.XXXXXX", "pi --no-extensions", "-e \"$BRO/bro.ts\"", "--no-context-files", "gh auth status", "/bro guided-review https://github.com/tranhoangnguyen03/pi-bro/pull/102", "/bro guided-review resume", "Leave this file unchanged", "110 columns × 32 rows", "git status --short", "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bro-reviews/"],
	},
];
