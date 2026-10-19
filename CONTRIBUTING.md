# Contributing

Thanks for helping. Bug reports and small, focused pull requests are welcome.
For bigger changes, open an issue first so we can agree on the shape.

## Set up and test

```sh
npm ci
npm test        # typecheck + offline tests with fake backend CLIs; never calls a model
pi --tui-mode fullscreen -e ./src/bro.ts
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) is the code map and lists the
invariants every change must keep. [docs/TESTING.md](docs/TESTING.md) is the
manual end-to-end checklist for changes the offline tests cannot cover.

## Pull requests

- One topic per PR. Link the issue it closes (`Closes #123`).
- If the PR changes a shipped runtime file, `package.json` or
  `package-lock.json`, bump the version with
  `npm version patch|minor|major --no-git-tag-version` and add a
  `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`, or label it
  `release:none` to ship it with a later release. CI checks this, and merging
  a version bump publishes it.
- Start each version's changelog section with `### Highlights`: 2–4
  plain-language bullets on what users can now do. It becomes the top of
  the GitHub release.
- Mark anything that breaks existing commands or settings under
  `### Breaking`, with migration steps.
- Update the relevant [feature guide](docs/README.md), [command reference](docs/reference/commands.md), and `/bro help` when user-visible behavior changes. Check permissions, retention, examples and troubleshooting together. Preserve old links when moving sections; keep model outputs labeled as examples, not verified results.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
