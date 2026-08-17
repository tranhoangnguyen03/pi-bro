# pi-bro

Simplify Pi's latest assistant response in a separate pop-up window without
adding extra messages to your conversation context.

`pi-bro` is a small extension for
[Earendil Pi](https://github.com/earendil-works/pi). It uses the
[Google Antigravity CLI](https://antigravity.google/docs/cli-install) (`agy`)
and a Gemini model to create plain-language explanations.

## Bro in action

**Before**

[![A dense coding-agent response before Bro](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-before.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-before.png)

**After `/bro`**

[![The same response explained in the Bro modal](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-after.png)](https://raw.githubusercontent.com/tranhoangnguyen03/pi-bro/main/docs/images/bro-after.png)

Bro optimizes for understanding, not simply for fewer words. The examples below
are synthetic coding-agent answers run through Bro's default prompt and edited
lightly for presentation and safety. Click a screenshot to see it at full size.

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
pi install git:github.com/tranhoangnguyen03/pi-bro
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
