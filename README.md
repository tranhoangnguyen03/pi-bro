# pi-bro

Simplify Pi's latest assistant response in a separate modal—without adding the
explanation to the main conversation.

`pi-bro` is a small prototype for
[Earendil Pi](https://github.com/earendil-works/pi). It currently uses
[Google Antigravity CLI](https://antigravity.google/docs/cli-install) (`agy`)
and a Gemini model as the external simplifier.

## Requirements

- Earendil Pi `>=0.78.1 <1` (tested with `0.84.2`)
- Node.js `>=22.19.0`
- `agy` installed, authenticated, and available on `PATH` (tested with `1.1.13`)
- Pi's interactive terminal UI

Install and launch `agy` once to complete authentication before using Bro.

## Install

From npm:

```sh
pi install npm:pi-bro
```

From GitHub:

```sh
pi install git:github.com/nguyen-tran-100x/pi-bro
```

Restart Pi or run `/reload`, then use `/bro` after an assistant response.

To try the npm package without installing it permanently:

```sh
pi -e npm:pi-bro
```

## Commands

| Command | What it does |
| --- | --- |
| `/bro` | Make a new plain-language explanation of the latest completed assistant response. |
| `/bro simplify` | Same as `/bro`. |
| `/bro open` | Reopen the last successful explanation without calling the simplifier again. |
| `/bro help` | Open the built-in guide. |

Inside the modal:

- **↑ / ↓** scroll
- **C** copy the full explanation
- **R** simplify the same response again
- **Esc** close, or cancel while Bro is working

## Customize the prompt

Bro uses a built-in prompt unless this file exists:

```text
~/.pi/agent/bro-prompt.md
```

The file must contain `{{response}}` exactly once. For example:

```md
Explain this in plain English in no more than 200 words.
Keep important warnings and next steps.

Assistant response:
{{response}}
```

Bro reads the file again for every simplification, so changes apply without a
reload. It never creates or edits the file.

Set `PI_BRO_MODEL` before starting Pi to override the default Agy model:

```sh
PI_BRO_MODEL=gemini-3.7-flash-low pi
```

## Files and privacy

- Bro sends the latest completed assistant response to Agy and its configured
  model provider.
- Bro does not append its explanation to Pi's conversation, session file, or
  main-agent context.
- The last successful explanation is kept only in process memory. It is cleared
  when you change Pi sessions, reload extensions, or exit Pi.
- Bro runs Agy in plan and sandbox modes from a temporary empty directory. This
  reduces project access, but it is not a security boundary.
- Bro itself does not edit project files. Agy may maintain its own configuration
  or logs, and Agy or its model provider may retain request data under their own
  settings and policies.
- Pressing **C** writes the explanation to your system clipboard, where your
  operating system or clipboard manager may retain it.

## Current limits

- Agy/Gemini is the only backend in v0.1.
- Only the latest successful explanation is cached.
- There is no explanation history or file export.
- Mouse capture is intentionally disabled; use arrow keys to scroll and **C** to
  copy the full result.

## Development

```sh
npm install
npm test
pi -e ./bro.ts
```

The smoke test is dependency-free and uses a fake `agy`; it does not call an
external model. It checks command routing, prompt customization, and that Bro's
result stays out of the Pi session and model context.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
