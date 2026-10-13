# pi-bro

[![npm](https://img.shields.io/npm/v/pi-bro)](https://www.npmjs.com/package/pi-bro)
[![tests](https://img.shields.io/github/actions/workflow/status/tranhoangnguyen03/pi-bro/publish.yml?branch=main&label=tests)](https://github.com/tranhoangnguyen03/pi-bro/actions/workflows/publish.yml)
[![node](https://img.shields.io/node/v/pi-bro)](package.json)
[![license](https://img.shields.io/npm/l/pi-bro)](LICENSE)

A sidekick for you and your Pi agent: plain-language explanations, side
questions, diagrams, PR review and second opinions, without cluttering the
agent's context.

`pi-bro` is an extension for [Pi](https://github.com/earendil-works/pi), a
terminal coding agent. Bro opens its answers in a separate window and runs
them through an AI coding CLI you already have and are signed in to, so your
main agent's conversation stays clean. Before you install, see
[what leaves your machine](#what-leaves-your-machine).

<p align="center">
  <img alt="Bro explains a dense agent reply in plain language, then answers a side question" src="https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-demo.gif" width="820">
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

| Type this in Pi | What happens |
| --- | --- |
| `/bro` | Explains the agent's last reply |
| `/bro file docs/report.pdf` | Explains a document (use your own path) |
| `/bro url https://example.com/article` | Explains a webpage (use your own link) |
| `/bro btw "what file defines this route?"` | Asks a side question |
| `/bro show` | Draws the last turn as a diagram |

## What it does

| Command | What you get |
| --- | --- |
| `/bro`, `/bro text`, `/bro file`, `/bro url` | **[Explain](docs/user-guide.md#what-bro-can-explain).** A plain-language version of the agent's last reply, pasted text, a PDF/DOCX/Markdown file, or a public webpage. Three modes: `brief`, `balanced`, `faithful`. |
| `/bro show` | **[Show](docs/user-guide.md#bro-show).** The last few turns drawn as a shape (call tree, file tree, diff, pseudocode, or an HTML diagram) instead of prose. |
| `/bro btw` | **[Side questions](docs/user-guide.md#bro-btw-side-conversation).** A separate conversation seeded with recent context, so you can ask without interrupting the agent. ⚠️ [Full-permission mode](#what-leaves-your-machine) can edit files. |
| `/bro guided-review <PR>` | **[Guided Review](docs/guided-review.md).** An explanation and quality assessment of a GitHub PR, with ranked findings, source evidence and private questions. Needs the Claude or Muse backend. |
| `bro_advisor` tool | **[Second opinion](docs/user-guide.md#bro-advisor).** A tool your agent can call mid-task; a fresh backend process investigates and returns advice to the agent. ⚠️ [Runs with permissions bypassed](#what-leaves-your-machine). |
| `/bro config`, `/bro preferences` | **[Settings](docs/user-guide.md#settings) and [preferences](docs/user-guide.md#preferences).** Pick the backend, model and effort per feature, and tell Bro how you like answers. |

Every command, control and setting is in the **[user guide](docs/user-guide.md)**.
Guided Review has its own [guide](docs/guided-review.md).

## Requirements

- Pi `>=0.84.2 <1` and Node.js `>=22.19.0`.
- macOS or Linux. Windows is untested; there, cancelling stops only the
  backend's direct process, not anything it started.
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

Each feature sends data to the backend you chose and its model provider,
which may keep it under their own policies. Paths below are under
`~/.pi/agent/` (or `$PI_CODING_AGENT_DIR`).

| Feature | What is sent | What Bro keeps on disk |
| --- | --- | --- |
| Explain | The agent's last reply, your pasted text, or text extracted from your file or webpage, plus your preferences | Nothing; the last result stays in memory |
| Show | User and assistant text from recent turns (no tool calls, tool results, reasoning or images), plus your preferences | HTML diagrams in `pi-bro-<uid>/` in your system temp folder |
| Side questions | Your questions and up to the last 8 turns of conversation text, plus your preferences | Nothing; the thread stays in memory |
| Guided Review | The PR description and diff, the files the backend reads, your questions, plus your preferences | Reviews and captured source in `bro-reviews/`, with no automatic cleanup |
| Advisor | The agent's system instructions, tool list and whole conversation, including tool calls and results (reasoning and images omitted), plus your steering | Steering in `bro-advisor.md` and the session file |

`/bro url` also connects straight to the website, which sees your IP address.
Bro runs each CLI as you, with your environment. It never reads or copies Pi's
provider credentials, but the CLI signs in its own way, which can include API
keys set in your environment. Nothing Bro produces enters Pi's conversation
unless you insert it, except advisor answers, which return to the agent as
tool results.

> [!WARNING]
> These run the backend in your workspace with its permission checks bypassed:
> - **Advisor:** it can read, edit and run commands. "Advise, don't edit" is
>   only an instruction.
> - **BTW full-permission mode** (turned on with `/mode` inside BTW): it is
>   meant to edit files and run commands.
> - **Grok, wherever you use it:** its sandbox is always off. "Answer only from
>   the supplied context" is only an instruction.

Details per backend:
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
npm ci
npm test        # offline: uses fake backend CLIs, never calls a model
pi --tui-mode fullscreen -e ./src/bro.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md), the [code map](docs/DEVELOPMENT.md)
and the [docs index](docs/README.md). Report security problems privately as
described in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
