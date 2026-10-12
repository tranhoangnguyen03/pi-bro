# Contributing

Thanks for helping. Bug reports and small, focused pull requests are welcome.
For bigger changes, open an issue first so we can agree on the shape.

## Set up and test

```sh
npm ci
npm test        # typecheck + offline tests with fake backend CLIs; never calls a model
pi --tui-mode fullscreen -e ./bro.ts
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) is the code map and lists the
invariants every change must keep. [docs/TESTING.md](docs/TESTING.md) is the
manual end-to-end checklist for changes the offline tests cannot cover.

## Pull requests

- One topic per PR. Link the issue it closes (`Closes #123`).
- If the PR changes a shipped runtime file, `package.json` or
  `package-lock.json`, bump the version with
  `npm version patch|minor|major --no-git-tag-version` and add a
  `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`. Otherwise label it
  `release:none`. CI checks this, and merging a version bump publishes it.
- Mark anything that breaks existing commands or settings under
  `### Breaking`, with migration steps.
- Update the [user guide](docs/user-guide.md) and `/bro help` when
  user-visible behavior changes.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
