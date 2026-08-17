# pi-bro

Simplify Pi's latest assistant response in a separate pop-up window without
adding extra messages to your conversation context.

`pi-bro` is a small extension for
[Earendil Pi](https://github.com/earendil-works/pi). It uses the
[Google Antigravity CLI](https://antigravity.google/docs/cli-install) (`agy`)
and a Gemini model to create plain-language explanations.

## Requirements

- Earendil Pi `>=0.78.1 <1` (tested on `0.84.2`)
- Node.js `>=22.19.0`
- `agy` installed, authenticated, and on your `PATH` (tested on `1.1.13`)
- Pi's interactive terminal UI

Run `agy` once in your terminal to complete sign-in before using Bro.

## Install

From npm:

```sh
pi install npm:pi-bro
```

From GitHub:

```sh
pi install git:github.com/nguyen-tran-100x/pi-bro
```

Restart Pi or run `/reload`. Once an assistant response finishes, run `/bro`.

To test Bro without installing it:

```sh
pi -e npm:pi-bro
```

## Commands

| Command | Description |
| --- | --- |
| `/bro` | Create a new plain-language explanation of the latest completed assistant response. |
| `/bro simplify` | Same as `/bro`. |
| `/bro open` | Reopen the latest explanation without calling the simplifier again. |
| `/bro help` | Open the built-in guide. |

### Modal controls

- **↑ / ↓**: Scroll up or down
- **C**: Copy the full explanation to your clipboard
- **R**: Run the simplifier again on the same response
- **Esc**: Close the window, or cancel while Bro is running

## Custom prompt

Bro uses a built-in prompt by default. To use your own, create:

```text
~/.pi/agent/bro-prompt.md
```

Your prompt must include `{{response}}` exactly once. For example:

```md
Explain this in plain English in no more than 200 words.
Keep important warnings and next steps.

Assistant response:
{{response}}
```

Bro re-reads this file every time you simplify, so your edits take effect
immediately without reloading Pi. Bro never creates or modifies this file.

### Custom model

Set `PI_BRO_MODEL` before starting Pi to use a different Agy model:

```sh
PI_BRO_MODEL=gemini-3.7-flash-low pi
```

## Privacy and files

- **External requests**: Bro sends the latest completed assistant response to
  Agy and its configured model provider.
- **Context isolation**: Bro does not add explanations to Pi's conversation
  history, session files, or main-agent context.
- **Memory cache**: The latest explanation is stored only in process memory for
  `/bro open`. It clears when you switch Pi sessions, reload extensions, or quit
  Pi.
- **File safety**: Bro does not modify project files. It runs Agy in plan and
  sandbox modes inside a temporary empty folder. This reduces project access,
  but it is not a security boundary.
- **Provider data**: Agy and your model provider may retain logs and request data
  according to their own settings and privacy policies.
- **Clipboard**: Pressing **C** copies the text to your system clipboard, where
  your operating system or clipboard manager may retain it.

## Current limits

- Supports only Agy/Gemini in v0.1.
- Keeps only the latest explanation in memory.
- Does not store history or export directly to files.
- Mouse scrolling is disabled; use the arrow keys to scroll and **C** to copy.

## Development

```sh
npm install
npm test
pi -e ./bro.ts
```

The smoke test uses a fake `agy`, so it does not call an external model. It
verifies command routing, custom prompt handling, and context isolation.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
