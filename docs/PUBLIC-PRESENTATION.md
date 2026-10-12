# Public presentation standard for pi-* extensions

How a pi-* repo looks to someone who lands on its GitHub or npm page for the
first time. Written for a solo maintainer: every rule is checkable, and each is
marked **MUST**, **SHOULD** or **NICE**.

The reader we design for: a developer who already uses (or is curious about)
Pi, has 10 seconds, and is deciding whether this is worth installing and safe to
run.

## Principles

1. **Show the job before the machinery.** Outcome, install and a picture come
   first. Backends, compatibility and caveats come after. Nobody reads the
   trust docs of a tool they don't yet understand.
2. **One idea, many verbs.** A repo with several features names the one idea
   that ties them together, and repeats it everywhere. Five unrelated features
   read as five risks.
3. **The README is the pitch; `docs/` is the manual.** The README gets someone
   from "what is this?" to a first success. Everything else is one link away.
4. **Say exactly what leaves the machine.** For agent tools, data flow and
   permissions *are* the trust decision. State them plainly, per feature, and
   point to them from the first screen.
5. **Promise only what you test.** `engines`, supported OSes, backends and
   "works with" claims match the CI matrix. Anything untested is labelled as
   such.
6. **Let the repo's state tell the truth.** About text, settings, open issues,
   branches and releases should reflect what the project is today. Stale
   metadata reads as abandoned.
7. **Sister repos should look like a family.** A shared skeleton, topics,
   badges and cross-links say "maintained set", not "scattered experiments".

## Checklist

### A. Discovery: GitHub About and npm metadata

- **MUST** The About description matches the `package.json` description and
  the README tagline (same sentence, at most about 150 characters). It says it
  is a Pi extension and names the benefit.
- **MUST** Topics: `pi-package`, `pi-extension`, `pi-coding-agent`, plus 2–5
  domain topics. `package.json#keywords` contains the same set.
- **MUST** Homepage is set: the npm package page, or a docs site if one exists.
- **SHOULD** A custom social preview image (1280×640) with the name, the
  tagline and one product visual.

### B. The README's first screen (roughly the first 30 lines)

- **MUST** In this order: name, badge row, one-line tagline, one sentence
  explaining what Pi is (linked), a hero visual, the install command, and a
  2–5 command "try it" block.
- **MUST** The badge row has 3–5 badges: npm version, CI status, license, and
  (if published with provenance) npm provenance or Node version. No vanity
  badges.
- **MUST** The hero visual (GIF, SVG cast or screenshot of the signature
  output) appears by line 40.
- **MUST** No caveats, experimental-runtime notes or backend matrices before
  the install block.
- **SHOULD** Name the first-run diagnostic command (e.g. `/bro doctor`) right
  after install.
- **SHOULD** If the name isn't self-explanatory, explain it in one line.

### C. README body and docs

- **MUST** The README stays at or under about 300 lines. Reference material
  (full command options, settings schema, precedence rules, per-backend
  detail, long examples) lives in `docs/` with a `docs/README.md` index.
- **MUST** Each feature gets a short block: what it does, one example, and a
  link to its doc.
- **MUST** Prerequisites list each required or optional external CLI with an
  install link, minimum version, and which one is the default.
- **MUST** If a feature needs a non-default setup (e.g. a specific backend),
  say so in that feature's README block, not only in deep docs.
- **SHOULD** Limits are one section of at most about 10 bullets, each written
  as *limit → workaround*. Avoid scattering caveats through the pitch.
- **SHOULD** Terminal visuals are reproducible (e.g. `charmbracelet/vhs`
  `.tape` files in `docs/tapes/`) so they get updated when the UI changes.
- **NICE** Light/dark image variants.

### D. Trust and safety disclosure (agent tools)

- **MUST** A "What leaves your machine" section: per feature, what is sent, to
  which backend or provider, and what persists where (workspace, `~/.pi/…`,
  temp, none). The first screen links to it.
- **MUST** Any mode that bypasses a backend's permissions or sandbox is
  flagged in a visible callout where that feature is introduced, not only in
  a table.
- **MUST** State plainly the difference between prompt instructions and
  enforced restrictions.
- **SHOULD** The diagnostic command is documented: what it checks, and that
  it sends no source text or model requests.

### E. Releases and versioning

- **MUST** A one-line stability statement in the README, e.g. "0.x: minor
  versions may change commands or settings; breaks are listed under
  **Breaking** in the release notes."
- **MUST** Any breaking change gets a `### Breaking` section with migration
  steps.
- **MUST** Each GitHub Release body opens with 2–4 plain-language bullets on
  what users can now do, followed by the detailed changelog section or a link
  to it.
- **SHOULD** Changelog entries are 1–2 lines each. Internal renames, tsconfig
  flags and test refactors stay in PRs.
- **SHOULD** Close the issue a release ships, via `Closes #N` in the PR.
- **NICE** Write down what 1.0 means (a stable command surface and settings
  schema).

### F. CI and supply chain

- **MUST** CI tests the minimum Node version in `engines` and the current
  LTS. Otherwise, narrow the `engines` claim.
- **MUST** Every CI job that guards a release is a required status check.
- **MUST** Supported OSes are stated. Untested means "unsupported" or
  "untested", not silence.
- **SHOULD** A macOS job when the tool spawns processes, uses the clipboard,
  or calls PATH CLIs.
- **SHOULD** Dependabot (or Renovate) for `github-actions` and `npm`, run
  weekly and grouped.
- **SHOULD** Third-party actions are pinned to commit SHAs.
- **SHOULD** Keep npm trusted publishing with `--provenance`.
- **NICE** CodeQL default setup and the OpenSSF Scorecard action and badge.

### G. Repository layout

- **MUST** About 15 root entries or fewer, so the README is reachable without
  scrolling past a file wall. Move tests, smoke scripts and helpers into
  `test/` and `scripts/` first.
- **MUST** No scratch or personal artifacts are committed. `.gitignore`
  covers them.
- **MUST** The `package.json#files` allowlist ships only the runtime and user
  docs.
- **SHOULD** Design plans live in `docs/plans/`, marked historical. Benchmark
  evidence lives in `benchmark/`, with a README saying what it does and does
  not prove.
- **NICE** Source in `src/`. Optional, because moving the Pi entry point
  touches `pi.extensions`, `files` and the imports.

### H. Settings, branches and issues

- **MUST** Allow squash merge only, and turn on "Automatically delete head
  branches".
- **MUST** Turn off empty Wiki and Projects tabs.
- **MUST** Delete merged or stale remote branches. Remote branches are only
  `main` and active PRs or spikes.
- **MUST** Open issues read as user-facing problems or requests. Internal work
  items carry a label (e.g. `maintenance`). Shipped issues are closed.
- **SHOULD** Pin one "Roadmap" issue.
- **SHOULD** Give 1–3 issues the `good first issue` label, or delete the label.

### I. Community files

- **MUST** `SECURITY.md`: how to report (with GitHub private vulnerability
  reporting turned on), supported versions (e.g. latest 0.x minor) and
  expected response time.
- **MUST** Issue forms: `bug.yml` (asks for extension version, Pi version,
  backend, OS, Node and diagnostic output), `feature.yml`, and `config.yml`
  (links for questions).
- **SHOULD** A 20–40 line `CONTRIBUTING.md`: setup, tests, release labels,
  and a link to `docs/DEVELOPMENT.md`.
- **NICE** `CODE_OF_CONDUCT.md` (Contributor Covenant).
- **SHOULD** Put shared defaults (SECURITY, CONTRIBUTING, issue forms, CoC) in
  a `tranhoangnguyen03/.github` repo so every sister repo inherits them.

### J. Family consistency

- **MUST** Every pi-* repo follows the README skeleton below and the
  tagline formula: *"<Name> — <what it does for you> in Pi, <key difference>."*
- **MUST** Every pi-* repo has a description, the shared base topics, a
  license, and a homepage.
- **SHOULD** All repos use the same license unless there is a reason not to.
- **SHOULD** A "More pi-* tools" footer cross-links the sister repos, and the
  profile README lists all of them with one line each.

### K. npm page parity

- **MUST** Images use absolute `raw.githubusercontent.com` URLs.
- **MUST** Check the rendered npm page after each release that changes the
  README: images show and doc links resolve. Use absolute GitHub URLs if npm
  does not resolve relative ones.

## README skeleton

```md
# <name>
<badges: npm · CI · license · provenance/node>

<Tagline.> <One sentence: what Pi is, linked.>

<hero visual>

## Install
pi install npm:<name>      # then /reload
<first-run diagnostic, if any>

## Try it
<2–5 commands>

## What it does
<one short block per feature + link to docs/<feature>.md>

## Requirements
<host versions; external CLIs with links, min versions, default>

## What leaves your machine
<short summary + link to full table>

## Limits
<≤10 bullets, limit → workaround>

## Stability
<0.x statement + link to releases>

## Docs · Contributing · Security · License
<links>

<More pi-* tools footer>
```

## Exemplars

- [Aider-AI/aider](https://github.com/Aider-AI/aider): the first screen has
  the pitch, a screencast, badges and install, before any caveat. Manual is
  off-README.
- [charmbracelet/vhs](https://github.com/charmbracelet/vhs) and
  [charmbracelet/gum](https://github.com/charmbracelet/gum): reproducible
  terminal GIFs, one per feature.
- [jesseduffield/lazygit](https://github.com/jesseduffield/lazygit): the UI
  visual sits at the very top, so there's no doubt what it looks like.
- [cline/cline](https://github.com/cline/cline): one tagline covers several
  surfaces.
- [modelcontextprotocol/servers — filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem):
  permission-first documentation.
- [anthropics/skills](https://github.com/anthropics/skills): one short scope
  disclaimer after the pitch, not before.
- [sindresorhus/execa](https://github.com/sindresorhus/execa): a
  solo-maintainer package with a tiny root and short security/contributing
  files.
- [openai/codex](https://github.com/openai/codex): issue forms that ask for
  version, OS and model up front.
- [OpenSSF Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md),
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
  [semver 0.x FAQ](https://semver.org/#how-should-i-deal-with-revisions-in-the-0yz-initial-development-phase),
  [opensource.guide best practices](https://opensource.guide/best-practices/).
