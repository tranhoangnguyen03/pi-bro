# Security policy

## Supported versions

Only the latest published `0.x` minor version receives fixes.

## Reporting a vulnerability

Please report privately through GitHub:
**Security → [Report a vulnerability](https://github.com/tranhoangnguyen03/pi-bro/security/advisories/new)**.
Do not open a public issue.

Useful details: pi-bro and Pi versions, the backend you selected, your OS, and
steps to reproduce.

## In scope

Problems in pi-bro's own code, for example:

- `/bro url` reaching local, private or reserved network addresses, or
  sending cookies or credentials.
- `/bro file` reading outside the current workspace.
- Bro sending data to a backend that the docs say it does not send.
- Bro's own files (settings, preferences, saved reviews, temp files) being
  written with unsafe permissions or outside their documented locations.
- Explain, Show or Guided Review gaining more backend access than
  [Backends: access and retention](docs/user-guide.md#backends-access-and-retention)
  describes.

## Out of scope

- Documented behavior: the advisor and BTW full-permission mode run the
  backend with its permission checks bypassed, and prompt instructions are
  not a sandbox.
- A model being misled by the text it reads (prompt injection) when no
  access boundary is crossed.
- Bugs in the backend CLIs (Agy, Claude Code, Grok, Codex, Muse) or in Pi
  itself; please report those upstream.
