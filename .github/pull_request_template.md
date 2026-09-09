## Release

- [ ] If this PR changes `bro.ts`, `prompt.ts`, `package.json`, or `package-lock.json`: bumped the version with `npm version patch|minor|major --no-git-tag-version` and added a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- [ ] Otherwise: labelled `release:none` if no release is intended.

CI enforces this. Merging a PR that bumps the version tags it, publishes to npm, and creates the GitHub release automatically.
