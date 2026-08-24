# Bro Modes and Benchmark Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Ship prompt hardening and only the Bro modes that pass one bounded 32-call benchmark, without changing custom prompts or context isolation.

**Architecture:** Move built-in prompt construction into one pure `prompt.ts` module shared by runtime and benchmark. Add a backward-compatible mode field and command in `bro.ts`. Add a small opt-in Agy benchmark with adapted MIT fixtures, resumable local results, mechanical gates, and a blind review artifact.

**Tech Stack:** TypeScript, Node.js built-ins, Agy CLI, Pi extension API, existing shell smoke test.

---

### Task 1: Shared prompt policy

**Files:**
- Create: `prompt.ts`
- Create: `prompt.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

**Step 1: Write failing prompt tests**

Use `node:test` and `node:assert/strict` to assert:

```ts
assert.equal(parseBroMode("brief"), "brief");
assert.equal(parseBroMode("unknown"), undefined);
assert.match(buildDefaultPrompt("hola", "balanced"), /Preserve the source language/);
assert.match(buildDefaultPrompt("hola", "balanced"), new RegExp(escapeRegExp(JSON.stringify("hola"))));
assert.match(buildDefaultPrompt("x", "brief"), /roughly 200 words/);
assert.match(buildDefaultPrompt("x", "balanced"), /Aim for 400 words/);
assert.match(buildDefaultPrompt("x", "faithful"), /Preserve every claim/);
```

Also assert every mode contains the injection, literal, warning, Markdown, and already-clear safeguards.

**Step 2: Run the test and verify it fails**

Run: `node --test prompt.test.ts`

Expected: FAIL because `prompt.ts` does not exist.

**Step 3: Implement the pure prompt module**

Define:

```ts
export const BRO_MODES = ["brief", "balanced", "faithful"] as const;
export type BroMode = (typeof BRO_MODES)[number];
export const DEFAULT_BRO_MODE: BroMode = "balanced";
export function parseBroMode(value: unknown): BroMode | undefined;
export function buildDefaultPrompt(response: string, mode: BroMode): string;
```

Build the prompt from one shared contract plus one mode paragraph. Preserve the existing target framing exactly in principle:

```ts
`Quoted text as a JSON string:\n${JSON.stringify(response)}`
```

Do not add a template engine or dependency.

**Step 4: Include and test the module**

- Add `prompt.ts` to `package.json#files`.
- Change `tsconfig.json#include` to cover root TypeScript files and `benchmark/**/*.ts`.
- Add `node --test prompt.test.ts benchmark/*.test.ts` to `npm test` before the smoke test.

Run: `npm test`

Expected: PASS.

**Step 5: Commit**

```bash
git add prompt.ts prompt.test.ts package.json tsconfig.json
git commit -m "Add hardened Bro prompt modes"
```

### Task 2: Persistent mode settings and command

**Files:**
- Modify: `bro.ts:22-56,447-486,631-722,861-921,1218-1421`
- Modify: `smoke-test.sh:49-90,214-268,359-390`

**Step 1: Write failing settings and command checks**

Extend the existing compiled assertions:

```ts
assert.deepEqual(parseBroSettings({ model: "gemini-one", effort: "high" }), {
  model: "gemini-one",
  effort: "high",
  mode: "balanced",
});
assert.deepEqual(parseBroSettings({ model: "gemini-one", effort: "low", mode: "faithful" }), {
  model: "gemini-one",
  effort: "low",
  mode: "faithful",
});
assert.throws(() => parseBroSettings({ model: "gemini-one", effort: "low", mode: "unknown" }));
```

Add RPC commands that select `faithful`, then change model and effort. Assert the saved settings still contain `mode: "faithful"`. Keep the fake Agy requirement for `CUSTOM_TEMPLATE_MARKER` so the smoke test proves a custom prompt remains untouched by mode selection.

**Step 2: Run tests and verify failure**

Run: `npm test`

Expected: FAIL because settings and routing do not support mode.

**Step 3: Implement backward-compatible settings**

Import `BroMode`, `BRO_MODES`, `DEFAULT_BRO_MODE`, `parseBroMode`, and `buildDefaultPrompt` from `./prompt.ts`.

Change `BroSettings` to include `mode`. In `parseBroSettings`, default only a missing mode to `balanced`; reject an explicitly invalid mode. Create new settings with `mode: "balanced"`.

Every settings write must preserve all fields:

```ts
await writeSettings({ ...currentSettings, model: selected.id, effort: selectedEffort });
await writeSettings({ ...current.settings, effort: selected });
```

Use the correct normalized current model where existing code requires it; never reconstruct a two-field object.

**Step 4: Add `/bro mode`**

- Add command completion and Help text.
- `/bro mode <value>` validates and saves directly.
- `/bro mode` opens a TUI selector, with the current mode first.
- Outside TUI, require an explicit value.
- Notify with `Bro mode: <mode>`.

Change built-in prompt loading to call `buildDefaultPrompt(response, settings.mode)`. A valid custom prompt still uses its exact template with `{{response}}` replaced by `JSON.stringify(response)` and does not receive mode clauses.

Doctor and Help show the saved mode and explain that `bro-prompt.md` overrides it when present.

**Step 5: Run tests**

Run: `npm test`

Expected: PASS, including exact settings persistence and existing context-isolation checks.

**Step 6: Commit**

```bash
git add bro.ts smoke-test.sh
git commit -m "Add persistent Bro mode selection"
```

### Task 3: Document user-visible behavior

**Files:**
- Modify: `README.md`

**Step 1: Add documentation checks to the smoke script**

Add simple repository assertions that README names all three modes, documents `balanced` as default, and says a custom prompt overrides the selected mode.

**Step 2: Run the smoke test and verify failure**

Run: `sh ./smoke-test.sh`

Expected: FAIL until README is updated.

**Step 3: Update README**

- Add `/bro mode [brief|balanced|faithful]` to commands.
- Explain the three policies and `balanced` default.
- Add `mode` to the settings JSON example.
- Replace the unconditional 400-word description with the mode-specific behavior.
- State that `bro-prompt.md` fully overrides built-in modes.
- Preserve all privacy claims.

**Step 4: Verify and commit**

Run: `npm test`

Expected: PASS.

```bash
git add README.md smoke-test.sh
git commit -m "Document Bro explanation modes"
```

### Task 4: Adapt SLYE fixtures and mechanical gates

**Files:**
- Create: `benchmark/baseline.ts`
- Create: `benchmark/corpus.ts`
- Create: `benchmark/benchmark.test.ts`
- Modify: `THIRD_PARTY_NOTICES.md`

**Step 1: Write failing corpus tests**

Assert:

```ts
assert.equal(BENCHMARK_CORPUS.length, 8);
assert.equal(new Set(BENCHMARK_CORPUS.map((fixture) => fixture.id)).size, 8);
assert.deepEqual(checkOutput(technicalFixture, technicalFixture.target).missingLiterals, []);
assert.ok(checkOutput(technicalFixture, "changed output").missingLiterals.length > 0);
assert.equal(checkOutput(injectionFixture, "INJECTION_SENTINEL").forbiddenText.length, 1);
```

Also test exact fenced blocks, occurrence counts, Markdown markers, likely preambles, unchanged detection, and length ratios.

**Step 2: Run tests and verify failure**

Run: `node --test benchmark/benchmark.test.ts`

Expected: FAIL because benchmark files do not exist.

**Step 3: Add the frozen baseline and corpus**

- Copy the current pre-change `DEFAULT_TEMPLATE` byte-for-byte into `benchmark/baseline.ts` and expose a builder that preserves `JSON.stringify` framing.
- Adapt the six SLYE fixtures; move injection instructions into the target and replace SLYE-specific literals with neutral/Bro-relevant ones.
- Add mixed-language and long-document fixtures.
- Keep fixture text synthetic and free of secrets.
- Implement only the approved mechanical checks in `benchmark/corpus.ts`.

**Step 4: Add attribution**

Add `wtfzambo/speak-like-you-eat`, its copyright, MIT notice, and a note that benchmark fixtures/checks were adapted to `THIRD_PARTY_NOTICES.md`.

**Step 5: Verify and commit**

Run: `npm test`

Expected: PASS.

```bash
git add benchmark/baseline.ts benchmark/corpus.ts benchmark/benchmark.test.ts THIRD_PARTY_NOTICES.md
git commit -m "Add adapted prompt benchmark corpus"
```

### Task 5: Build the bounded Agy runner

**Files:**
- Create: `benchmark/run.ts`
- Modify: `benchmark/benchmark.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

**Step 1: Write failing manifest tests**

Assert a dry manifest has exactly 32 unique rows and that changing any prompt, fixture, mode, model, or effort changes its stable call ID. Assert no benchmark command appears in `npm test` except offline benchmark unit tests.

**Step 2: Run tests and verify failure**

Run: `node --test benchmark/benchmark.test.ts`

Expected: FAIL because runner exports do not exist.

**Step 3: Implement one CLI**

Support:

```text
node benchmark/run.ts dry-run
node benchmark/run.ts run --approve <fingerprint>
node benchmark/run.ts report
```

The manifest uses SHA-256 over stable JSON containing prompt variant, prompt hash, fixture hash, model `gemini-3.7-flash`, effort `low`, and timeout. `dry-run` makes no provider calls.

Before the first live row, call Agy usage and print the current limits. Execute rows sequentially with production-equivalent arguments:

```text
agy --sandbox --disable-slash-commands --output-format stream-json \
  --model gemini-3.7-flash --effort low --print-timeout 2m --print <prompt>
```

Use a temporary empty working directory, a 125-second process timeout, and the existing stream event contract. Save each result atomically under `benchmark/.work/<call-id>.json`. Skip only settled results with the exact current call ID. On Ctrl-C, timeout, auth/rate failure, or malformed output, save what is known and stop. Never retry automatically.

`report` writes mechanical results, a hidden candidate mapping, and `blind-review.md` with blank 0–2 fields for clarity, fidelity, safety/preservation, and mode adherence.

**Step 4: Wire scripts and ignores**

Add:

```json
"benchmark:dry-run": "node benchmark/run.ts dry-run",
"benchmark:run": "node benchmark/run.ts run",
"benchmark:report": "node benchmark/run.ts report"
```

Ignore `benchmark/.work/`.

**Step 5: Verify offline behavior and commit**

Run:

```bash
npm test
npm run benchmark:dry-run
```

Expected: tests PASS; dry run reports 32 rows and no Agy calls.

```bash
git add benchmark/run.ts benchmark/benchmark.test.ts .gitignore package.json
git commit -m "Add resumable Agy prompt benchmark"
```

### Task 6: Run the initial matrix once

**Files:**
- Local ignored output: `benchmark/.work/*`
- Optionally create after review: `benchmark/initial-results.md`

**Step 1: Confirm clean automated verification**

Run: `npm test`

Expected: PASS.

**Step 2: Print and inspect the approved matrix**

Run: `npm run benchmark:dry-run`

Expected: 32 rows, one pinned model/effort, four prompt variants, eight fixtures, and a fingerprint.

**Step 3: Run exactly once with resumability**

Run: `npm run benchmark:run -- --approve <fingerprint>`

Expected: usage preflight, then at most 32 sequential calls. Do not restart failed calls automatically.

**Step 4: Generate and review the report**

Run: `npm run benchmark:report`

Apply the bounded gate:

- Reject a mode on any hard preservation/safety failure.
- Confirm each surviving mode has visibly distinct value.
- Treat one pass as directional evidence only.
- Permit at most one prompt correction pass; otherwise omit the failing mode.

**Step 5: Record the decision, not a research archive**

If useful for the release, create `benchmark/initial-results.md` with the manifest fingerprint, model/effort, call outcomes, mechanical failures, concise blind-review conclusions, limitations, and ship/omit decision. Do not commit ignored raw outputs or secrets.

Commit only if the report is created:

```bash
git add benchmark/initial-results.md
git commit -m "Record initial Bro mode benchmark"
```

### Task 7: Final verification and review

**Files:**
- Review all changed files

**Step 1: Run full verification from a clean state**

```bash
npm ci
npm test
npm pack --dry-run --json
npm run benchmark:dry-run
```

Expected: all commands succeed; package contents include `bro.ts` and `prompt.ts`, exclude tests and benchmark work files, and dry run remains 32 rows.

**Step 2: Inspect release invariants**

```bash
git status --short
git diff main...HEAD --check
git diff main...HEAD --stat
```

Expected: no unstaged files, no whitespace errors, and only planned files changed.

**Step 3: Request code review**

Use the requesting-code-review skill. Require reviewers to check settings migration, JSON-string source framing, custom-prompt precedence, paid-call safeguards, attribution, and session/context isolation.

**Step 4: Apply only verified blocking fixes**

Use the receiving-code-review skill. Do not start optional prompt tuning or benchmark expansion.

**Step 5: Re-run final verification and commit fixes**

Run the Step 1 commands again after any accepted fixes. Commit only reviewed changes.

---

## Explicitly deferred

Direct Pi-provider completion receives a separate design and plan after this release candidate. No provider implementation, fallback, or dual-provider abstraction belongs in this branch.
