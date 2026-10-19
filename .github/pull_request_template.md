## Release

- [ ] If this PR changes any shipped runtime module (`package.json#files` excluding docs), `package.json`, or `package-lock.json`: bumped the version with `npm version patch|minor|major --no-git-tag-version` and added a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`.
- [ ] Otherwise: labelled `release:none` if no release is intended.

CI enforces the two items above. Merging a PR that bumps the version tags it, publishes to npm, and creates the GitHub release automatically.

Checked in review, not by CI:

- [ ] A version section opens with `### Highlights`: 2–4 plain-language bullets on what users can now do. The release workflow copies the section into the GitHub release as-is.
- [ ] Anything that breaks existing commands or settings is listed under `### Breaking` in `CHANGELOG.md`, with migration steps.

## Documentation check

- [ ] A new user can find and follow the changed task from the [docs home](docs/README.md).
- [ ] Updated commands, key bindings, settings and examples match shipped runtime behavior.
- [ ] The feature guide covers expected result, recovery, data sent, storage, model access and limits; claims of enforcement reflect actual backend controls.
- [ ] `/bro help` and README summaries link to the owning guide, without repeating long behavior descriptions.
- [ ] Docs-only changes preserve old links and move (rather than silently delete) valuable examples.
- [ ] Ran `npm run docs:check`; for modal/permissions changes, recorded manual verification in [TESTING.md](docs/TESTING.md).

Only label a live interaction **verified** after testing it in the intended Pi host; offline tests do not prove UX or model quality.
