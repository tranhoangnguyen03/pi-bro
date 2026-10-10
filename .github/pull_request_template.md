## Release

- [ ] If this PR changes any shipped runtime module (`package.json#files` excluding docs), `package.json`, or `package-lock.json`: bumped the version with `npm version patch|minor|major --no-git-tag-version` and added a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- [ ] Otherwise: labelled `release:none` if no release is intended.

CI enforces this. Merging a PR that bumps the version tags it, publishes to npm, and creates the GitHub release automatically.

## Docs

- [ ] Changed user-visible behavior is reflected in `README.md`, `/bro help` (in `bro.ts`), and any affected prompt in `prompt.ts` or `review.ts`. Guided Review details/limits must match `docs/guided-review.md`.
- [ ] Changed architecture, invariants, or manual checks are reflected in `docs/DEVELOPMENT.md` or `docs/TESTING.md`. Check user/agent documentation links, current labels, access/privacy, storage and verification claims together; historical plans must not contradict current instructions.
