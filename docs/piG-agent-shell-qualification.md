# PiG-Agent shell qualification — issue #177

**Status:** Bro 0.36.1 candidate. Direct **PiG 0.5.3 TUI and RPC** checks passed with synthetic CLI input; the *installed PiG-Agent package*, a genuine model-provider answer, and live subscription accounts are **not yet qualified**.

## Exact inputs and responsibility

| Part | Initial PiG-Agent PR #2 pin | Bro qualification work |
| --- | --- | --- |
| PiG binary | 0.5.3 | Unchanged |
| Node | 24.15.0 | Unchanged |
| PiG-Agent PR #2 | Initially `3f121638feaf9c8a551a2d7001481cd7d936a8c9`; later `eef7162241a8a65c1774043e172f90fe2d082110` | Rebuild with reconciled Bro 0.36.1 |
| Bro | 0.29.0 at `ff6b260b10be8889809d4ea02108aceb826e4668` | Reconciled with main 0.36.0 at `55f050343ec9e48afc5b6768596326b5714c5278`; PR stages 0.36.1 |
| Other extensions | Follow `shell/source-lock.json` in PiG-Agent PR #2 | Not changed by this PR |

Do **not** label the newer Bro commit as a test of the old Bro 0.29.0 artifact. Pin this PR's eventual full commit and its actual `package.json` version in the shell lock; rebuild the full native shell and record the resulting artifact digest. Reviewer/Engineering prompts are not involved in the gate.

## Bro → shell contracts

**Storage:** Bro's settings, preferences, approved memories and Pi model runtime resolve through the host's `getAgentDir()`, rather than the main Pi home. The shell sets `PIG_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR` to `<agent-home>/.pi`. The installed application and sessions remain distinct from that directory. `models.json` lives at `<agent-home>/.pi/models.json`; Bro does not search the main Pi directory or import another model format.

**Pi model selection:** The selected full `<provider>/<model-id>` is exact (split on the first slash). At execution Bro requires the model from the **host registry** and passes that physical model object (API, endpoint, limits and overrides) to the inner Pi session. A model not found in the host fails; it is never replaced with a similarly named default. Bro builds a private runtime for model transport, registrations and credentials. PiG-Agent owns optional source selection and any import/link of a shared `models.json`; changes to that source require a supported host reload or a new PiG session. No claim that the external CLI catalogs use `models.json`.

**Official CLI profiles:** PiG-Agent chooses the account source and supplies `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the agent launch environment. Bro does not store profiles. With no explicit choice, the backends simply inherit the existing CLI environment and normal login. If the shell deliberately chooses a subscription, it also sets one of the following **backend-only intent flags**:

```sh
PI_BRO_CLAUDE_AUTH_SOURCE=subscription  # Claude Code child, CLAUDE_CONFIG_DIR as selected by shell
PI_BRO_CODEX_AUTH_SOURCE=subscription   # Codex child, CODEX_HOME as selected by shell
```

Values are `inherit` (the default) or `subscription`. An unknown value fails, rather than falling back. These flags are a small bridge for the shell's account choice, not a new account store or user-facing configuration menu. The environment of each child is copied, never changed on `process.env`. In subscription mode:

- Claude child removes API-key, bearer-token, alternate-endpoint and supported alternate-cloud environment overrides, then checks `claude auth status` for `loggedIn=true` with `authMethod=claude.ai` **before** a model call.
- Codex child removes `CODEX_API_KEY` and `OPENAI_API_KEY`, checks `codex login status` for ChatGPT login, and adds `-c 'forced_login_method="chatgpt"'` to the execution child. Codex's credential-store choice (e.g. `cli_auth_credentials_store`) still belongs to its selected `CODEX_HOME` profile.
- A status check does **not** identify the human account by itself, prove that a request was sent, or verify subscription billing. The acceptance run must verify the effective account with non-secret CLI evidence and a genuine answer. Missing login or non-subscription login prevents the model request. No API-key fallback is attempted.

**Lifecycle:** Cancellation uses existing bounded process-group termination. Bro retains main's tracked, awaited backend shutdown on session lifecycle. The real PiG 0.5.3 RPC host test now confirms awaited reload cancellation and clean EOF with a synthetic child. Installed-shell hard exit and desktop exit are still **NOT RUN**; PiG-Agent owns its worker lifetime.

## Verified direct PiG 0.5.3 host checks (not packaged shell)

[GitHub Actions run 42568585956](https://github.com/tranhoangnguyen03/pi-bro/actions/runs/42568585956) ran on Linux x64 using PiG `0.5.3+1.4.0.74f46864`, Node `24.15.0`, and a downloaded PiG archive with SHA-256 `1e45e5e591a06d087587d5f09d2b6d61673a1e262cb2609e6189defffd5ae7ec`.

- **PASS:** Real host RPC reload cancels an active fake CLI child, awaits teardown and accepts a fresh command. EOF terminates its child without a late result (2/2 host tests).
- **PASS:** Real PiG 0.5.3 loaded `<agent-home>/.pi/models.json` containing only `study/probe`; Bro's Pi backend issued a real HTTP request to the file's local OpenAI-compatible endpoint using the selected model ID and bearer credential. After editing that file's endpoint and credential, a **new PiG host/session** called only the new endpoint and used its new key (1/1 custom-model test). No external provider was called.
- **PASS:** In an actual pseudo-terminal, `/bro config` shows Global/Features; `/bro text` opens Simplify and displays a completed fake Agy answer; `/bro remember-me` shows its private memory view; `/bro preferences` opens its editor; `/bro btw` opens its side-question composer and returns a **fresh** backend answer; keyboard input, resize and Esc work.
- **PASS:** Full Bro CI at the same commit: 572/572 tests in the main job, Node 22/Linux, Node 24/macOS, and legacy PiG 0.3.0 lane.
- **NOT RUN:** Packaged PiG-Agent application with Bro 0.36.1 pinned; a genuine **remote provider** answer and actual billing method; two authorized accounts; clipboard transfer; all remaining advanced terminal journeys and hard-exit behavior. The custom endpoint test uses a local server and does not qualify a paid provider.

These tests load the extension from its source checkout in the **real PiG host**, not from a PiG-Agent installed release. A fake Agy CLI is not a subscription or provider request. The custom-model test makes real HTTP requests but only to a local test server; it is not evidence of an external provider's auth or billing.

## Reproducible acceptance on the *packaged* shell

Build the exact PiG-Agent PR #2 source with the Bro PR head pinned. Install it into **two fresh independent homes** `A` and `B` using `shell-reference install --home DIR`. Run `doctor` for each and record actual PiG/Node/Bro/CLI versions, commit SHA, installed archive SHA256, platform and where `getAgentDir()` resolves.

1. **TUI, not RPC:** Run `shell-reference new --home A` in a real terminal. Use a real authorized backend and try `/bro`, `/bro simplify` (inside it `/text`, `/url`, `/file`, `/copy`, `/clear`, `/help`), `/bro config`, `/bro preferences`, `/bro btw`, and `/bro remember-me`. Exercise text input, selection, scrolling, resize, Esc/cancel and clipboard. Verify a real final backend answer. Check `/bro guided-review`, `/bro advisor`, `/bro elevate`, `/bro grill-me`, `/bro show`, `/bro overthink`, `/bro architecture`, and `/bro doctor`; mark unexercised paths **NOT RUN**, not PASS.
2. **Cleanup:** During a long real Claude/Codex/Pi request, use cancel, `/reload` and exit, then inspect child PIDs/grandchildren. A terminal exit must not leave an active backend. Test the same with a fast failure, slow backend and missing executable.
3. **Models:** Start with no `A/.pi/models.json`, check built-ins. Add an agent-local custom provider with a harmless locally controlled test endpoint; confirm picker listing, unchanged provider/model ID, request URL, configured credentials and metadata overrides in a real result. Break its key and definition and confirm useful failure with no fallback. Edit model file; check the host's supported reload/new session. Test enabled-model scopes and default settings separately.
4. **Accounts:** With an already-authorized host Claude login, run with `CLAUDE_CONFIG_DIR` inherited and then with the shell-selected profile and `PI_BRO_CLAUDE_AUTH_SOURCE=subscription`. Confirm non-secret CLI account/method and actual answer. Repeat Codex with `CODEX_HOME` and `PI_BRO_CODEX_AUTH_SOURCE=subscription`. Test inherited API key collisions, missing/expired login, forced method and parent API env retention. For two distinct authorized accounts, test concurrent A/B routing; otherwise mark the second live account **NOT RUN**.
5. **Isolation:** New sessions must not inherit another task's transcripts/side questions; an approved general Remember Me lesson stays available in A but not B. Inspect A and B settings, memory, session roots and model sources after concurrent use, reinstall and compatible rollback.

**Fixtures:** `npm test` includes deterministic fake CLI source-routing, conflicting auth, no-fallback and process-stop tests plus host registry model identity. The additional PiG 0.5.3 CI lane runs the real host/terminal with a synthetic Agy backend **and** runs Bro's Pi SDK against two real local HTTP model endpoints, confirming model ID, URL, credential and new-host edited-source behavior. Both remain distinct from an installed PiG-Agent release and live subscription evidence.

## Specific PiG-Agent PR #2 work remaining

1. Add a shell-side account/model-source chooser (or clear documented setup) which picks each installed agent's existing CLI profile and optional shared `models.json` source, installs/seeds local models before launch, and supplies the **same resolved inputs** to TUI, print and RPC. It must not blindly share the main Pi home.
2. For a deliberate subscription choice, export the matching `PI_BRO_*_AUTH_SOURCE=subscription` flag **only in that installed shell's launch env**. Keep the normal process login untouched. Bro handles backend-child auth filtering.
3. Update `shell/source-lock.json` to this PR's exact Bro commit and matching version; rebuild a native release with PiG 0.5.3/Node 24.15.0, then execute the matrix above. Do not treat the existing smoke command registration as TUI qualification.
4. Verify that PiG reload and hard exit tear down the Node extension worker and its backends; if not, fix the PiG host lifetime owner rather than adding a second shell worker manager.

## Qualification matrix — actual observations

| Journey | Fixture / CI | Direct PiG 0.5.3 host | Installed PiG-Agent shell | Authorized account |
| --- | --- | --- | --- | --- |
| Simplify/config/preferences/BTW/Remember Me, resize/keyboard/Esc | **PASS** | **PASS** (synthetic Agy TUI) | **NOT RUN** | **NOT RUN** |
| Full scroll/clipboard, Guided Review, Advisor, Elevate, Grill Me, Show, Overthink, Architecture | Unit coverage varies | **NOT RUN** | **NOT RUN** | **NOT RUN** |
| Reload cancellation and EOF process cleanup | **PASS** | **PASS** (RPC, 2/2) | **NOT RUN** | **NOT RUN** |
| Host-selected Pi model identity, endpoint, key and file edits | **PASS** | **PASS** — local HTTP custom model and fresh host | **NOT RUN** | **NOT RUN** |
| Claude/Codex profile routing, billing-safe subscription choice | **PASS** — fake CLI | **NOT RUN** — real CLI | **NOT RUN** | **NOT RUN** |
| Two isolated homes, fresh task and approved lesson | **PASS** — memory-root fixture | **NOT RUN** | **NOT RUN** | **NOT RUN** |

A fixture PASS does not establish the installed shell, real account identity, or paid request. To close #177, pin Bro 0.36.1 in PiG-Agent PR #2, rebuild, complete the missing installed-shell and live checks and record their exact source/artifact versions.
