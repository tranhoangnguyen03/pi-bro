# Set up models and preferences

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## Settings

Use `/bro config` for the layered Global and Features menu. Its editable pages retain the existing backend/model/effort pickers, save checks and per-capability overrides. Changes save immediately. Esc inside a
picker cancels that pick; Esc on the settings screen closes it, keeping
whatever was already saved. If the terminal becomes too small, config blocks
hidden actions; Esc closes config even if a picker was open, after pending saves
finish. A failed save cancels that close and shows its error inline; if the error
alone makes config too small, any other key clears it so you can try again. `/bro mode` changes the mode directly (**M** in an explanation
tries another mode without saving it), and `/bro help` shows the active settings
and file path.

### Config navigation

```text
/bro config
├── Global
│   ├── Default backend, model and effort
│   ├── Preferences (opens the existing shared editor)
│   └── Doctor (runs only when selected)
└── Features
    ├── Simplify — Explain override and default brief/balanced/faithful mode
    ├── Show — Show override and default turn count
    ├── BTW — backend/model/effort override
    ├── Guided Review — Review override
    ├── Advisor — override and persistent steering editor
    ├── Elevate — inherits BTW (informational)
    ├── Grill Me — inherits BTW (informational)
    └── Remember Me — inherits BTW (informational)
```

The BTW page shows what the selected backend can do in conversation-only mode,
and reminds users that `/mode` **inside BTW** switches to full workspace access.
Guided Review shows its selected backend's real inspection limits: strict file
tools on some backends, sandboxed shell on others, and Agy's ability to write
within the captured checkout. These are explanations of existing behavior,
not a new permission switch or an extra compatibility restriction. See
[backend access and retention](data-and-permissions.md#backends-access-and-retention).

Enter drills down. Esc backs out or closes at root; editors use their existing
save/cancel behavior. Opening Config does **not** run Doctor, touch a model, or
modify settings. Current selected models and overrides remain visible in the
existing editing pages. The old `/bro doctor`, `/bro preferences` and
`/bro advisor-steer` shortcuts remain callable.

Architecture Docs inherits the **BTW** backend/model/effort selection. It uses a fresh restricted file-inspection call and does not alter the BTW thread. See [Architecture Docs](../features/architecture.md).

Elevate inherits the **BTW** backend/model/effort selection. There is no separate Elevate setting in this release. See the [Elevate guide](../elevate.md).

Settings live in this user-editable file, created when the extension loads
(under `$PI_CODING_AGENT_DIR` instead when that is set):

```text
~/.pi/agent/bro-settings.json
```

```json
{
  "version": 2,
  "default": { "backend": "agy", "model": "gemini-3.7-flash", "effort": "low" },
  "mode": "balanced",
  "showTurns": 1,
  "overrides": {
    "explain": { "backend": "claude", "model": "sonnet", "effort": "medium" },
    "advisor": { "backend": "grok", "model": "grok-4.7", "effort": "high" },
    "review": { "backend": "pi", "model": "anthropic/claude-sonnet-4-5", "effort": "high" }
  }
}
```

Bro reads the file again before each request, so manual edits apply next time.

- Each selection is one atomic backend/model/effort choice. An override pins
  its own complete selection and ignores the shared default, even when it
  happens to match it; select **Default** in `/bro config` to inherit again.
  Omitted overrides inherit `default`.
- `effort` must be one the backend offers (`default` omits it and lets the
  model decide). Agy selections are normalized against Agy's installed model
  catalog. Claude, Grok, Codex, and Muse accept seeded or custom model IDs; a model/effort
  combination the account does not support fails with the backend's own error
  instead of silently falling back. **Pi** selections are a `"<provider>/<id>"` pair
  from your Pi model catalog, chosen from your configured scoped models
  (`enabledModels`, falling back to every model with configured credentials).
  Explicit Pi efforts are clamped to the model's supported reasoning levels; the
  picker's own step 1 chooses the backend and step 2 the model.
- `mode` is `brief`, `balanced` (the default), or `faithful`. `showTurns` is
  the default number of turns `/bro show` draws (default 1); `/bro show
  <n-turns>` overrides it for one run.
- `PI_BRO_MODEL` picks the initial Agy model only when Bro creates a missing
  settings file, for example `PI_BRO_MODEL=gemini-3.7-flash-low pi`.
- Older flat settings files (root `model`/`effort`) still load and mean Agy.

## Launcher contract for CLI authentication

This contract is available to any launcher of Bro's Pi-compatible extension,
not only PiG-Agent. It selects authentication intent for the **Claude Code and
Codex backends**; it does not make either CLI a host for Bro's UI or tools.

### Ownership and launch inputs

- The launcher chooses an existing CLI profile and passes its location through
  `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). If unset, the official
  CLI uses its normal profile lookup. Bro does not find, create or switch accounts.
- The official CLI owns login, credential storage and refresh. Authenticate the
  selected profile through that CLI; Bro does not copy tokens or manage logins.
- Bro owns its independent sessions and backend execution. It reads the intent
  below when preparing backend children; these flags do not select a backend or
  model. Choose those separately with `/bro config`.
- A launcher that offers this choice passes the same selected profile and intent
  to interactive, print and RPC launches. The flags belong in that launch's
  environment, not in `bro-settings.json` or a shared global account setting.

| Backend | Existing profile selector | Bro authentication intent |
| --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `PI_BRO_CLAUDE_AUTH_SOURCE` |
| Codex | `CODEX_HOME` | `PI_BRO_CODEX_AUTH_SOURCE` |

Each intent flag accepts exactly `inherit` or `subscription`. Unset means
`inherit`; any other value, including an empty string, fails for that backend.

- **`inherit`:** Bro preserves the CLI's ordinary authentication environment and
  behavior. It does not require a subscription login or reject custom API routes.
- **`subscription`:** Bro checks the official CLI's login method and applies the
  backend-specific policy below. A failed check stops the request; Bro does not
  fall back to API-key authentication or silently select another provider.

For example, launch native Pi with an **already authenticated** Codex profile:

```sh
CODEX_HOME="$HOME/.codex" PI_BRO_CODEX_AUTH_SOURCE=subscription pi
```

Bro must already be installed and its selected backend must be Codex. A different
launcher passes these same environment variables to its host process; it does not
need a separate Bro authentication implementation. To return to ordinary CLI
behavior, omit the intent flag or set it to `inherit` on the next launch.

### Backend-child policy

Bro copies the parent environment, removes both Bro intent flags from the child,
and leaves the parent's environment unchanged. Subscription filtering applies to
that backend child only; it does not change the host's model credentials or
another backend's authentication.

- **Claude Code:** Remove `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and
  `CLAUDE_CODE_USE_FOUNDRY`. Require `claude auth status` to report
  `loggedIn=true` and `authMethod=claude.ai` before model execution.
- **Codex:** Remove `CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` and
  `CHATGPT_BASE_URL`. Require ChatGPT login and inspect the selected profile's
  effective provider configuration through the official app-server `config/read`.
  Accept the implicit or explicit built-in OpenAI route; reject custom providers,
  overrides of the built-in provider and endpoint redirects. Unreadable configuration
  also stops execution. Bro uses Codex's effective configuration, not its own TOML
  parser. After validation, execution pins that route and the ChatGPT login method.

`/bro doctor` applies the same explicit subscription checks as execution. A passing
check establishes the tested login method and route, **not** a successful live
answer, human account identity or subscription billing. See the
[implementation notes](../DEVELOPMENT.md#official-cli-subscription-policy) for
Codex's inspection-only catalog and the [PiG qualification guide](../piG-agent-shell-qualification.md#codex-provider-route-regression-and-diagnostic-parity)
for the versioned real-CLI/local-server evidence.

## Preferences

Tell Bro about yourself and how you like answers. Bro adds what you write to
every explain, `/bro show`, `/bro btw`, `/bro elevate`, and Guided Review prompt as a labelled section,
alongside its own instructions. It never replaces them: modes, **M**, and the
source rules keep working. The advisor never receives your preferences; use
`/bro advisor-steer` for it.

Run `/bro preferences` to edit them: **Ctrl+S** saves, **Ctrl+K** deletes the
file, **Ctrl+C** copies, and **Esc** closes without saving. The first time,
the editor opens with this starter text, which is not saved until you press
**Ctrl+S**:

```md
## About me
I'm an overworked white-collar worker, and so are my colleagues. By the end of a
hard day our brains are fried and we can only handle simple language, no matter
how sharp we are at our best.

## How I like answers
- Explain it like I'm a simpleton: plain, everyday words.
- Go easy on analogies. No forced ones.
```

You can also edit the file directly (under `$PI_CODING_AGENT_DIR` instead when
that is set):

```text
~/.pi/agent/bro-preferences.md
```

- **Free-form**: no placeholder or structure is required. Bro re-reads the
  file on every request, so edits apply next time. A missing or empty file
  means no preferences, and Bro's prompts are then exactly the built-in ones.
- **What preferences can change**: wording, tone, technical depth, length in
  BTW, and the answer language. If you name a language, code, commands, paths,
  names, and numbers still stay exactly as written. In `/bro show` and `/bro overthink`,
  preferences only change wording/tone and language. Guided Review also receives preferences for explanation/answer wording; they do not override its evidence or review rules. A per-run choice (the mode,
  **M**, a Show steering query, or what a BTW/review question asks for) wins over a
  standing preference.
- **Limit**: 4,000 characters, because the text goes with every request. A
  longer file stops explain, Show, BTW, Guided Review, and manual Overthink checks with an error until you trim it (automatic Overthink checks are skipped quietly);
  Bro never cuts it silently. `/bro doctor` reports the problem, and the
  editor still opens the file so you can fix it.
- **BTW threads**: when your preferences change, the next side question starts
  a fresh backend session that is caught up on the thread, so old preferences
  don't linger.

`bro-prompt.md`, the full prompt template from earlier versions, is no longer
read. Move what you want to keep into `/bro preferences`, and choose
`/bro mode brief` for the original ELI-simpleton instruction.

## Remember Me

`/bro remember-me` manages approved personal memories in `bro-memories.json` in the same user agent directory. Each entry has a stable ID, a scan-first short statement, and optional scope, exceptions, uncertainty and source context in an expanded view. The agent-facing `about_user` tool reads them on demand. `/bro preferences` remains a separate legacy file; no automatic migration or duplicate injection occurs. See [Remember Me](../remember-me.md).
