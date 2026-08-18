# pi-bro

Turn a dense AI reply, pasted text, local document, or public webpage into a plain-language
explanation without adding anything to your main agent's context.

`pi-bro` is an extension for [Earendil Pi](https://github.com/earendil-works/pi).
It opens explanations in a separate modal and uses the
[Google Antigravity CLI](https://antigravity.google/docs/cli-install) (`agy`)
with your selected model.

## Quick start

You need Earendil Pi `>=0.78.1 <1`, Node.js `>=22.19.0`, and `agy >=1.1.11`
installed and available on your `PATH`. Run `agy` once in your terminal to sign
in, then install Bro:

```sh
pi install npm:pi-bro
```

Restart Pi or run `/reload`, then try:

```text
/bro
/bro file docs/report.pdf
/bro url https://example.com/article
```

Run `/bro doctor` after installation or whenever Bro is not working.

To install from GitHub instead, use
`pi install git:github.com/tranhoangnguyen03/pi-bro`. To try Bro without
installing it, use `pi -e npm:pi-bro`.

## What Bro can explain

| Source | Command | What Bro does |
| --- | --- | --- |
| Latest assistant reply | `/bro` | Explains the latest completed reply without adding the result to the conversation. |
| Pasted text | `/bro simplify <text>` | Explains text supplied directly in the command. |
| Local document | `/bro file <path>` | Extracts text from a workspace-local Markdown, text, PDF, or DOCX file. |
| Public webpage | `/bro url <url>` | Fetches one public HTML page and extracts its main readable content. |

Pressing **R** simplifies the captured source again. Running a new `/bro file`
or `/bro url` command reads or fetches a fresh copy.

## Commands

| Command | Description |
| --- | --- |
| `/bro` or `/bro simplify` | Explain the latest completed assistant response. |
| `/bro simplify <text>` | Explain pasted text. |
| `/bro file <path>` | Explain a workspace-local `.md`, `.markdown`, `.txt`, `.pdf`, or `.docx` file. |
| `/bro url <url>` | Explain one public, text-based webpage. |
| `/bro open` | Reopen the latest explanation without calling the simplifier again. |
| `/bro doctor` | Check Bro's settings, Agy installation, account, model, and effort. |
| `/bro usage [--provider agy]` | Show current Agy resource limits. |
| `/bro model [id]` | View or choose the Agy model. |
| `/bro effort [low\|medium\|high]` | View or choose the supported reasoning effort. |
| `/bro help` | Open the built-in quick reference. |

### Modal controls

- **Mouse wheel / trackpad**: Scroll in regular or fullscreen mode
- **↑ / ↓**: Scroll in any mode
- **C**: Copy the complete explanation
- **R**: Simplify the captured source or run the current Doctor check again
- **Esc**: Close the modal, or cancel while Bro is working

Bro temporarily captures mouse input while its modal is open. Native mouse
selection may be unavailable or visually extend outside the modal depending on
your terminal mode; press **C** to copy the complete explanation reliably.

## Bro in action

### Assistant response

**Before `/bro`: the original agent response**

[![A dense assistant response before Bro](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-before.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-before.png)

**After `/bro`: the plain-language explanation**

[![The assistant response explained in the Bro modal](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-response-after.png)

### Local document

**Before: a complex PDF**

[![A complex PDF before Bro](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-before.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-before.png)

**After `/bro file <path>`**

[![The PDF explained in the Bro modal](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-after.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-file-after.png)

Bro optimizes for understanding, not simply for fewer words. The written
examples below are synthetic and were run through Bro's default prompt. Click
a screenshot to see it at full size.

<details>
<summary><strong>Short:</strong> TypeScript says a value is <code>never</code></summary>

### Before

> The diagnostic is not evidence that `result` is intrinsically uninhabitable; it is an artifact of TypeScript's intraprocedural control-flow graph. Because `result` is initialized to `null` and only assigned inside the `forEach` callback, the outer scope does not model that callback as definitely executing. After `if (!result) return`, the remaining branch therefore collapses to `never`, producing the property-access error. Replace the callback-driven mutation with a control-flow-visible loop: `for (const item of items) { if (matches(item)) { result = item; break; } }`. Alternatively, derive the value expressionally with `const result = items.find(matches);` and guard `if (!result) return;` before dereferencing it. Avoid an `as Result` assertion; it suppresses the symptom while preserving the unsound state transition that caused the narrowing anomaly.

### After `/bro`

#### What happened

TypeScript showed an error saying your variable `result` cannot be used or
accessed.

This happened because `result` was set to `null` outside a `forEach` loop and
then modified inside the loop's helper function (callback). TypeScript tracks
code line by line. It cannot guarantee that code inside a `forEach` callback
will actually run.

#### What it means

Because TypeScript assumes the loop's callback might not run:

1. It believes `result` might still be `null`.
2. When you check `if (!result) return`, TypeScript thinks `result` can never
   hold a valid value after that check.
3. It sets the type of `result` to `never` (a special type meaning "impossible
   value") and blocks you from reading its properties.

The error is a limitation in how TypeScript analyzes loops with callbacks.

#### What you should do next

Choose one of these two fixes:

**Option 1: Use a standard `for...of` loop**

```ts
for (const item of items) {
  if (matches(item)) {
    result = item;
    break;
  }
}
```

**Option 2: Use `Array.prototype.find`**

```ts
const result = items.find(matches);
if (!result) return;
```

Avoid using a type assertion like `as Result`. It only hides the warning
without fixing the underlying tracking issue.

</details>

<details>
<summary><strong>Medium:</strong> Login succeeds, but the user is still logged out</summary>

### Before

> What you're observing is almost certainly not an authentication failure in the credential-validation layer; it is a post-authentication session persistence failure caused by an environment-dependent mismatch between Express's transport-security inference and the TLS termination topology in production.
>
> Locally, Express sees the request as plain HTTP and your development cookie configuration probably permits a non-secure session cookie. In production, however, the browser connects over HTTPS to Nginx, a load balancer, or an ingress controller, which terminates TLS and forwards the request to Node over HTTP. Unless Express trusts that intermediary, `req.secure` remains `false`, even when the proxy sends `X-Forwarded-Proto: https`. With `cookie.secure: true`, `express-session` can consequently decline to emit the cookie because it believes the originating request was insecure. The login route may still return `200`, making the credentials appear accepted, but the next request has no session identifier and is treated as anonymous.
>
> Configure proxy trust before registering session middleware, and make the cookie policy reflect whether the frontend and API are same-site or genuinely cross-site:
>
> ```js
> app.set("trust proxy", 1);
>
> app.use(session({
>   secret: process.env.SESSION_SECRET,
>   resave: false,
>   saveUninitialized: false,
>   proxy: true,
>   cookie: {
>     httpOnly: true,
>     secure: true,
>     sameSite: "lax",
>     maxAge: 1000 * 60 * 60 * 24
>   }
> }));
> ```
>
> Use `sameSite: "none"` instead of `"lax"` only when the browser must send the cookie in a cross-site context, such as a frontend and API on unrelated registrable domains. Browsers require `Secure` when `SameSite=None`, so that combination must remain HTTPS-only. Separate subdomains such as `app.example.com` and `api.example.com` are usually same-site, though they are still cross-origin.
>
> Also verify that the proxy explicitly forwards `X-Forwarded-Proto`, that the browser receives a `Set-Cookie` response header, and that frontend requests use `credentials: "include"` when crossing origins. If CORS is involved, the server must return the exact allowed origin plus `Access-Control-Allow-Credentials: true`; a wildcard origin is incompatible with credentialed requests.
>
> Avoid setting a cookie `domain` unless sharing across subdomains is intentional. A host-only cookie is safer and eliminates another production-only failure mode.

### After `/bro`

#### What happened

Your username and password check succeeded, and the login route returned `200
OK`. However, the browser did not receive or return a usable session cookie in
production.

#### What it means

In production, secure web traffic (HTTPS) hits an intermediary, such as a load
balancer or Nginx, before reaching your Node/Express app as plain HTTP.

Because your session cookie requires HTTPS (`secure: true`), Express may withhold
it when it does not trust the proxy forwarding the request. The exact trust
setting must match your deployment's proxy topology.

#### What you should do next

1. Configure Express to trust only your actual proxy topology. Put this before
   the session setup. For example, use `1` only when there is exactly one trusted
   proxy hop:

   ```js
   app.set("trust proxy", 1);

   app.use(session({
     secret: process.env.SESSION_SECRET,
     resave: false,
     saveUninitialized: false,
     cookie: {
       httpOnly: true,
       secure: true,
       sameSite: "lax",
       maxAge: 1000 * 60 * 60 * 24
     }
   }));
   ```

2. Check your cookie settings:
   - Keep `sameSite: "lax"` if your frontend and backend share the same main
     domain, such as `app.example.com` and `api.example.com`.
   - Use `sameSite: "none"` only when the cookie must be sent cross-site.
     Browsers require `secure: true` with this setting.
   - Avoid defining a custom cookie `domain` unless you deliberately need to
     share cookies across subdomains.

3. Verify the proxy, browser, and CORS settings:
   - Ensure the proxy forwards the `X-Forwarded-Proto` header.
   - Check that the response contains a `Set-Cookie` header.
   - Include `credentials: "include"` in cross-origin frontend requests.
   - Return the exact allowed origin with
     `Access-Control-Allow-Credentials: true`. Do not use a wildcard (`*`) for
     credentialed requests.

</details>

<details>
<summary><strong>Long:</strong> A CI build fails only when its cache is restored</summary>

### Before

> The failure is not a nondeterministic pnpm installation problem, despite the misleading first error being emitted from the test runner immediately after dependency hydration. It is a state-contamination problem at the intersection of the repository cache, the package export map, and an incorrectly scoped cache key. The decisive observation is that the same commit succeeds in a clean checkout and in CI when cache restoration is disabled, but fails when the pre-build workspace cache is restored. That isolates the variable to files materialized outside Git rather than source, Node, or runner image drift.
>
> The affected package, `@acme/config`, was recently migrated from a dual CommonJS/ESM build to an ESM-oriented TypeScript output. Its root `package.json` declares `"type": "module"` and maps the `import` condition to `./dist/index.js`, while the legacy `require` condition still maps to `./dist/index.cjs`. The current compiler emits `index.js` but does not remove the previous build directory first. An older cached `dist` directory therefore contributes two files that no longer belong to the current build graph: `dist/index.cjs` and `dist/package.json`, the latter declaring `"type": "commonjs"`. The new compiler overlays `dist/index.js` but leaves both obsolete files intact. Because nested package boundaries override the root package type, Node interprets the newly emitted ESM `index.js` as CommonJS in that restored workspace and reports `Unexpected token 'export'`. Test processes entering through `require()` instead resolve the obsolete `index.cjs`, which references a removed chunk and can instead produce `MODULE_NOT_FOUND`. These apparently different errors are two projections of the same dirty-output condition.
>
> The cache configuration makes that contaminated state persistent. The workflow computes the key with `hashFiles('packages/**/pnpm-lock.yaml')`, but this workspace has only the root-level `pnpm-lock.yaml`. GitHub Actions consequently evaluates the hash expression to an empty value, yielding a key equivalent to `Linux-node20-workspace-`. A broad restore key then permits an archive produced before the module-format migration to satisfy the lookup. That archive combines the pnpm content-addressable store, Turborepo metadata, and every package's `dist` directory. Those data classes do not share valid invalidation semantics: pnpm store entries are immutable by content, Turborepo artifacts are task-hash addressed, and arbitrary build directories are mutable snapshots whose correctness depends on complete deletion or exact provenance. Treating them as one cache effectively elevates obsolete untracked files into undeclared build inputs.
>
> The evidence is visible by comparing the restored and clean workspaces before compilation. In the failing job, `packages/config/dist/package.json` exists with `"type":"commonjs"` and `packages/config/dist/index.cjs` has a timestamp and checksum predating the current commit. Neither file appears after `git clean -ffdx` followed by installation and build. The Actions cache log also shows the truncated key without a lockfile digest, while `git diff` remains empty because the problematic files are ignored. Finally, deleting only `packages/config/dist` before rerunning the unchanged test command converts the failure to a pass, which excludes dependency resolution and network variability as primary causes.
>
> The minimal durable remediation has three parts. First, stop caching package output directories. Cache the pnpm store separately, using a key that includes the actual root lockfile:
>
> ```yaml
> key: ${{ runner.os }}-node20-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
> restore-keys: |
>   ${{ runner.os }}-node20-pnpm-
> ```
>
> A broad fallback is acceptable for the pnpm store because pnpm validates content-addressed entries; it is not acceptable for mutable `dist` snapshots. If remote or local Turborepo caching is retained, cache only `.turbo` and allow Turbo's task hash to govern artifact reuse rather than wrapping raw workspace outputs in a generic archive.
>
> Second, make every package build replace, rather than merge into, its output directory. `@acme/config` should delete `dist` before invoking `tsc`, `tsup`, or the existing bundler. The CI workflow should also run the repository's recursive clean target before the first build as a defense against future cache or runner reuse. This is not a substitute for fixing cache scope, but it restores the invariant that generated output is a function of the checked-out sources and declared toolchain.
>
> Third, make the export contract agree with emitted files. If `@acme/config` is intentionally ESM-only, remove the `require` condition and the obsolete CommonJS metadata. If CommonJS consumers remain supported, restore an explicit CJS build that deterministically emits `dist/index.cjs`; do not let a historical artifact impersonate that support. In either case, package publication should reject export targets that do not exist.
>
> Verification should exercise both cache states and both module entry paths. Run the full pipeline once with no cache, save only the corrected caches, and rerun the identical commit expecting a cache hit and the same result. Inspect the built package to confirm the nested CommonJS `package.json` and legacy chunks are absent unless intentionally generated. Add a lightweight smoke check using dynamic `import('@acme/config')`; if CommonJS remains supported, add a second check through `createRequire`. Finally, change the root lockfile and confirm the logged cache key changes. That matrix validates clean-build reproducibility, restored-cache reproducibility, export-map coherence, and dependency-cache invalidation independently rather than relying on a single green run.

### After `/bro`

#### What happened

Your build failed because old files were left behind by a broken cache (a saved
snapshot of previous build files).

The package `@acme/config` recently switched its module format to modern
JavaScript (ESM). However, the build process did not delete the old output
folder (`dist`) before creating new files.

Because the GitHub Actions setting searches the wrong path
(`hashFiles('packages/**/pnpm-lock.yaml')`), GitHub could not find the root
`pnpm-lock.yaml`. It restored an outdated cache containing `dist/index.cjs` and
a `dist/package.json` configured for older JavaScript (CommonJS). The new build
wrote some files but left the old ones behind, confusing Node and causing errors
such as `Unexpected token 'export'` and `MODULE_NOT_FOUND`.

A clean checkout without the cache succeeds. This proves the problem is old
cached files, not your source code or dependencies.

#### What it means

- **Cache contamination:** The CI workflow restores mutable `dist` folders
  alongside package-manager files, mixing obsolete files into new builds.
- **Mismatched module settings:** The package says it supports both modern
  (`import`) and legacy (`require`) formats, but it only builds the modern one
  while relying on leftover cached files for the legacy one.

#### What you should do next

1. **Fix the GitHub Actions cache:** Stop caching `dist` folders. Cache only the
   pnpm store, using the root lockfile:

   ```yaml
   key: ${{ runner.os }}-node20-pnpm-${{ hashFiles('pnpm-lock.yaml') }}
   restore-keys: |
     ${{ runner.os }}-node20-pnpm-
   ```

   If you use Turborepo, cache only `.turbo`.

2. **Clean output folders before building:** Make `@acme/config` delete `dist`
   before running `tsc`, `tsup`, or the bundler. Run the repository's recursive
   clean command before CI builds.

3. **Update the package exports:**
   - If `@acme/config` is ESM-only, remove the `require` entry and old CommonJS
     metadata.
   - If CommonJS is still needed, add a real build step for `dist/index.cjs`.

4. **Verify the fix:**
   - Delete the generated `packages/config/dist` folder, then run a clean build.
     Do not use `git clean -ffdx` in a working copy with files you need.
   - Run the workflow without a cache, save the new cache, and rerun the same
     commit to verify that a cache hit also passes.
   - Test `import('@acme/config')`, and test `createRequire` if CommonJS is
     supported.

</details>

## Explain a document

Use a path relative to Pi's current workspace, or an absolute path inside it:

```text
/bro file docs/incident review.pdf
```

Paths may contain spaces; matching single or double quotes are also accepted.
Bro extracts text locally, then sends that text through the same explanation
flow used by `/bro`. Pressing **R** retries the extracted snapshot; running a
new `/bro file <path>` command reads the file again.

Files are limited to 10 MiB and 100,000 extracted characters. Scanned PDFs are
not supported because Bro does not perform OCR.

## Explain a webpage

Pass one public HTTP or HTTPS page:

```text
/bro url https://example.com/complicated-article
```

Bro fetches the page, extracts its main readable text locally, and sends only
that text through the existing explanation flow. The completed modal shows the
final website and page title. Pressing **R** retries the captured page without
fetching again; running a new `/bro url <url>` command fetches a fresh copy.

The first version is intentionally limited to one public, text-based page. It
does not use browser cookies, sign in, run page JavaScript, bypass paywalls or
bot protection, load complete discussion threads, follow pagination, or
understand images and video. Pages that depend on those features may fail.

If Bro cannot read a page, copy its content into a `.txt` or `.md` file, or save
it as a PDF, then use `/bro file <path>`.

## Check your setup

Run `/bro doctor` when Bro is newly installed or something is not working. It
checks Bro's settings and prompt, the installed Agy version, account access,
available models, and the selected reasoning effort. Failed checks explain what
to fix.

Doctor contacts Agy for its model catalog and account usage. It does not send an
assistant response or run a model completion, so it does not consume a model
turn. A successful check confirms the setup, but cannot guarantee that a later
provider request will succeed.

## Settings

Bro creates this user-editable settings file when the extension loads:

```text
~/.pi/agent/bro-settings.json
```

```json
{
  "model": "gemini-3.7-flash",
  "effort": "low"
}
```

Use `/bro model` and `/bro effort` to update it from Pi, or edit it directly.
Bro reads the file again before each explanation, so manual changes apply to
the next `/bro`. Use a model ID shown by `/bro model`; `effort` must be
one of the levels shown by `/bro effort`. Models without adjustable effort use
`default`. The choices remain active across Pi restarts until you change them.
`/bro help` shows the active settings and the exact file path.

If `PI_CODING_AGENT_DIR` is set, the file lives there instead. `PI_BRO_MODEL`
chooses the initial model only when Bro creates a missing settings file:

```sh
PI_BRO_MODEL=gemini-3.7-flash-low pi
```

## Custom prompt

Bro uses a built-in prompt by default. To use your own, create:

```text
~/.pi/agent/bro-prompt.md
```

Your prompt must include `{{response}}` exactly once. For example:

```md
Explain this in plain English in no more than 200 words.
Keep important warnings and next steps.

Text to explain:
{{response}}
```

Bro re-reads this file every time you simplify, so your edits take effect
immediately without reloading Pi. Bro never creates or modifies this file.

## Privacy and safety

- **External requests**: Bro sends the latest completed assistant response,
  pasted text, extracted document text, or extracted webpage text to Agy and its
  configured model provider.
- **Usage checks**: `/bro usage` checks your authenticated Agy limits without
  sending an assistant response or running a model turn.
- **Setup checks**: `/bro doctor` checks Agy account and model availability
  without sending an assistant response or running a model turn.
- **Context isolation**: Bro does not add explanations to Pi's conversation
  history, session files, or main-agent context.
- **Memory cache**: The latest explanation is stored only in process memory for
  `/bro open`. It clears when you switch Pi sessions, reload extensions, or quit
  Pi.
- **File safety**: `/bro file` reads only regular files whose resolved path is
  inside Pi's current workspace, including after resolving symlinks. Bro does
  not modify them. It runs Agy in sandbox mode inside a temporary empty folder.
  This reduces project access, but it is not a security boundary. Bro only
  writes its own user settings file described above.
- **Web requests**: `/bro url` connects directly to the target website. The site
  sees your IP address and Bro's user agent. Bro sends no browser cookies,
  authorization, or referrer information, and it refuses local, private, and
  reserved network destinations, including redirects. Avoid private or signed
  URLs whose query string contains secrets.
- **Web extraction**: Bro parses downloaded HTML locally without executing page
  scripts or loading page subresources. It sends the extracted readable text,
  including links preserved in that text, to Agy; it does not separately send
  the requested URL or raw page HTML. The URL, captured text, and explanation
  remain in process memory only and clear with the existing `/bro open` cache.
- **Provider data**: Agy and your model provider may retain logs and request data
  according to their own settings and privacy policies.
- **Clipboard**: Pressing **C** copies the text to your system clipboard, where
  your operating system or clipboard manager may retain it.

## Troubleshooting and current limits

If an explanation fails, run `/bro doctor` first. If a webpage cannot be
extracted, copy its content into a supported text file or save it as a PDF and
use `/bro file`. If a PDF contains only scanned images, run OCR with another
tool before giving it to Bro.

- Uses Agy as its only provider.
- Document input supports `.md`, `.markdown`, `.txt`, `.pdf`, and `.docx` only;
  it does not perform OCR.
- Webpage input supports one public HTML page, up to 5 MiB downloaded and
  100,000 extracted characters. JavaScript-only, authenticated, paywalled,
  blocked, paginated, and media-first pages are not supported.
- Direct webpage fetching does not currently use `HTTP_PROXY`, `HTTPS_PROXY`,
  or other proxy environment variables.
- Keeps only the latest explanation in memory.
- Does not store history or export directly to files.
- Bro temporarily captures mouse input while its modal is open so mouse-wheel
  and trackpad scrolling work in regular and fullscreen modes. Native mouse
  selection may be unavailable or visually extend outside the Bro window;
  press **C** to copy the full explanation instead.

## Development

```sh
npm install
npm test
pi --tui-mode fullscreen -e ./bro.ts
```

The smoke test uses a fake `agy`, so it does not call an external model. It
verifies command routing, document and URL safety boundaries, HTML extraction,
healthy and broken setup handling, settings, custom prompt handling, and
context isolation.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
