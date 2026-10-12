# pi-bro

[![npm](https://img.shields.io/npm/v/pi-bro)](https://www.npmjs.com/package/pi-bro)
[![tests](https://img.shields.io/github/actions/workflow/status/tranhoangnguyen03/pi-bro/publish.yml?branch=main&label=tests)](https://github.com/tranhoangnguyen03/pi-bro/actions/workflows/publish.yml)
[![node](https://img.shields.io/node/v/pi-bro)](package.json)
[![license](https://img.shields.io/npm/l/pi-bro)](LICENSE)

A sidekick for you and your Pi agent: plain-language explanations, side
questions, diagrams, PR review and second opinions, all kept out of the
agent's context.

`pi-bro` is an extension for [Pi](https://github.com/earendil-works/pi), a
terminal coding agent. Bro opens its answers in a separate window and runs
them through an AI coding CLI you already have and are signed in to, so your
main agent's conversation stays clean.

<p align="center">
  <a href="https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png">
    <img alt="A dense agent reply explained in plain language in the Bro window" src="https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png" width="820">
  </a>
</p>

## Install

```sh
pi install npm:pi-bro
```

Then restart Pi or run `/reload`, and check your setup:

```text
/bro doctor
```

To try Bro without installing it, run `pi -e npm:pi-bro`. To install from
GitHub, use `pi install git:github.com/tranhoangnguyen03/pi-bro`.

## Try it

```text
/bro                                   explain the agent's last reply
/bro file docs/report.pdf              explain a document
/bro url https://example.com/article   explain a webpage
/bro btw "what file defines this route?"
/bro show                              draw the last turn as a diagram
```

## What it does

| Command | What you get |
| --- | --- |
| `/bro`, `/bro text`, `/bro file`, `/bro url` | **Explain.** A plain-language version of the agent's last reply, pasted text, a PDF/DOCX/Markdown file, or a public webpage. Three modes: `brief`, `balanced`, `faithful`. |
| `/bro show` | **Show.** The last few turns drawn as a shape (call tree, file tree, diff, pseudocode, or an HTML diagram) instead of prose. |
| `/bro btw` | **Side questions.** A separate conversation seeded with recent context, so you can ask without interrupting the agent. |
| `/bro guided-review <PR>` | **Guided Review.** An explanation and quality assessment of a GitHub PR, with ranked findings, source evidence and private questions. Needs the Claude or Muse backend. |
| `bro_advisor` tool | **Second opinion.** A tool your agent can call mid-task; a fresh backend process investigates and returns advice. |
| `/bro config`, `/bro preferences` | Pick the backend, model and effort per feature, and tell Bro how you like answers. |

Every command, control and setting is in the **[user guide](docs/user-guide.md)**.
Guided Review has its own [guide](docs/guided-review.md).

## Requirements

- Pi `>=0.84.2 <1` and Node.js `>=22.19.0`.
- At least one backend CLI on your `PATH`, signed in once from your terminal.
  You only need the one you use:

| Backend | CLI | Notes |
| --- | --- | --- |
| [Google Antigravity](https://antigravity.google/docs/cli-install) | `agy` | Default for new settings. Needs `>=1.1.15`. Not for Guided Review. |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` | Works for every feature, including Guided Review. |
| [Grok Build](https://docs.x.ai/build/overview) | `grok` | Not for Guided Review. |
| [Codex CLI](https://github.com/openai/codex) | `codex` | Not for Guided Review. |
| [Muse Code](https://dev.meta.ai/docs/muse-code) | `muse` | Works for every feature, including Guided Review. |

- Guided Review also needs Git and an authenticated [`gh`](https://cli.github.com/).
  Choose Claude or Muse for it in `/bro config`.
- [PiG](docs/pig-compatibility.md) support is experimental.

## What leaves your machine

Bro sends what you ask it to explain (the agent's reply, your text, extracted
document or page text, or recent conversation text) to the backend you chose
and its model provider. Bro uses that CLI's own account; it never reads Pi's
provider credentials. Nothing Bro produces is added to Pi's conversation
unless you insert it, and the advisor's answer comes back as a normal tool
result.

> [!WARNING]
> Two modes run the backend in your workspace with its permission checks
> bypassed: the **advisor** and **BTW full-permission mode** (turned on with
> `/mode` inside BTW). Their "advise, don't edit" limits are instructions,
> not a sandbox.

How each backend is restricted, and what is stored where:
[Backends: access and retention](docs/user-guide.md#backends-access-and-retention)
and [Privacy and safety](docs/user-guide.md#privacy-and-safety).

## Limits

- Documents: `.md`, `.markdown`, `.txt`, `.pdf`, `.docx` only, no OCR, up to 10 MiB.
  → Run OCR elsewhere first.
- Webpages: one public HTML page; no logins, paywalls, page JavaScript or
  proxy settings. → Save the page as PDF or text and use `/bro file`.
- No fallback: if the chosen backend, model or effort fails, Bro shows that
  backend's error instead of switching. → Run `/bro doctor`.
- BTW threads and the last explanation live in memory only and clear on
  reload or restart.
- Guided Review runs in local interactive Pi only and does not post to
  GitHub.

Full list: [Troubleshooting and current limits](docs/user-guide.md#troubleshooting-and-current-limits).

## Stability

Bro is `0.x`: a minor version can change commands or settings. Breaking
changes are listed under **Breaking** in the [changelog](CHANGELOG.md) and the
[release notes](https://github.com/tranhoangnguyen03/pi-bro/releases). Each
release is published to npm from CI with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

## Contributing

```sh
npm install
npm test        # offline: uses fake backend CLIs, never calls a model
pi --tui-mode fullscreen -e ./bro.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the [code map](docs/DEVELOPMENT.md)
and the [docs index](docs/README.md). Report security problems privately as
described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
