# Release automation: keep npm and GitHub releases in sync

## Problem

Merging a pull request should publish the same version to npm and GitHub without
a second manual release step, and the major/minor/patch bump should be decided
per PR. Before this change the repo had no CI at all, GitHub tags stopped at
v0.6.0 and the only GitHub release was v0.1.0, while npm was already at 0.10.0.

## Design

Three workflows plus one script.

| file | trigger | does |
|---|---|---|
| `.github/workflows/ci.yml` | pull request | `npm test`; validate release metadata |
| `.github/workflows/publish.yml` | push to `main`, manual | tag, publish to npm, create the GitHub release |
| `.github/workflows/sync-check.yml` | daily cron, manual | compare npm latest vs latest GitHub release, open/update an issue |
| `.github/scripts/release-utils.mjs` | — | version/bump/label/lockfile/CHANGELOG checks; drift comparison |

### Version bump

The bump is decided in the pull request: the author runs
`npm version patch|minor|major --no-git-tag-version` (updates `package.json`
and `package-lock.json`) and adds a `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG
section. The `release:major|minor|patch` label is optional intent; when
present, `ci.yml` requires it to match the actual version diff. `release:none`
opts a PR out of releasing.

If a PR changes `bro.ts` or `prompt.ts` without bumping `package.json`, CI
fails with the exact command to run. Docs/CI-only PRs pass and release
nothing. No bot ever commits to `main` and no changelog text is generated.

### Release order

`publish.yml` runs on every push to `main` and is a no-op when
`package.json` is already tagged and published. Otherwise:

1. create and push the annotated tag `vX.Y.Z`;
2. `npm publish --access public --provenance` via npm trusted publishing
   (OIDC, no stored token);
3. `gh release create` with notes extracted from the CHANGELOG section.

Each step has its own precondition check, so a failed run can be resumed with
`workflow_dispatch`. The only reachable partial state is "tag exists, npm does
not have the version yet" — a re-run completes it. A GitHub release is never
created for a version npm does not have, and `main` never receives a release
commit.

### Accounts

- GitHub for this repository: `tranhoangnguyen03` (the bot account has
  pull-only access).
- npm: `tranhoangnguyen0310`, authorized through npm trusted publishing for
  `tranhoangnguyen03/pi-bro`, workflow `publish.yml`.
- The release workflow itself uses `GITHUB_TOKEN` (`github-actions[bot]`).

## Hardening after review

- `main` requires branches to be up to date before merging (`strict`), so two
  PRs cannot merge the same target version and silently drop one release.
- `ci.yml` re-runs on `labeled`/`unlabeled`, so adding or removing a release
  label re-evaluates the metadata check.
- The release workflow is split: a read-only `verify` job runs install and
  tests; only the `release` job gets `id-token: write`, and `npm publish` runs
  with `--ignore-scripts`, so dependency install scripts never see an
  OIDC-minting token.
- Publishing checks out the tag first, so a re-run after `main` has moved still
  publishes the tagged tree.
- `workflow_dispatch` is restricted to `refs/heads/main`.
- Version output reaches the shell through `env:`, never by interpolation.
- `validate` treats `package.json` and `package-lock.json` as shipped, so a
  dependency-only change still requires a release.
- `release:none` cannot be combined with another release label.
- `sync-check` closes a resolved drift issue and fails loudly instead of
  silently ignoring a version it cannot parse.
- `publish.yml` accepts a `verify_only` dispatch input that mints a GitHub OIDC
  token and exchanges it with npm without publishing, so trusted publishing
  can be proven before a release. It lives in this workflow because npm binds
  the trusted publisher to the workflow filename.

## Recovery

- **Orphan tag** (publish failed permanently and the tag cannot be reused):
  an admin can delete it (`git push --delete origin vX.Y.Z`) because the tag
  ruleset allows admin bypass. Then bump to the next version in a new PR.
- **Broken `ci.yml` or renamed `test` job**: temporarily relax branch
  protection through the API, land the fix through a PR, then re-enable.
- **Failed publish**: fix the cause and re-run `release` via
  `workflow_dispatch`; every step is idempotent.

## Known limitations

- `v0.6.0` is tagged in git but was never published to npm; that historical
  pair can never be in sync.
- Older npm versions are not backfilled. `sync-check.yml` uses
  `BASELINE=0.10.0` so it reports only new drift; the first `publish.yml` run
  after this lands tags and releases 0.10.0, which is already on npm.
- GitHub Actions does not trigger workflows for pushes made with
  `GITHUB_TOKEN`, so tagging and publishing live in one workflow rather than a
  tag-triggered chain.
- npm trusted publishing is verified by the `verify_only` dispatch (npm
  returns `201` and mints a publish token); the first real publish exercises
  the full path.
- Prerelease versions (`1.0.0-beta.1`) are not supported by the bump check or
  the drift comparison.
