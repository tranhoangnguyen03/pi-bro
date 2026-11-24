# Explain text, files and webpages

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

**Simplify** turns one source into something easier to understand, in plain words or as a [diagram of recent conversation](show.md#bro-show). Opening `/bro` or `/bro simplify` shows your saved result, or command help if none exists. It does not call the model. Run `/simplify` inside the modal (or `/bro simplify latest` directly) to explain the latest completed assistant reply.

## Explanation modes

Bro treats quoted source as data and asks the model to ignore embedded
instructions found in it. This is a prompt instruction, not an enforced security
boundary. Bro preserves the source's language (unless your [preferences](../reference/settings.md#preferences) name another), and avoids
adding facts, advice, or conclusions in every mode. Choose
a persistent mode with `/bro mode`, or press **M** in an explanation to try the
next mode without saving it:

- **`brief`**: Uses the original audience-led ELI-simpleton prompt with no fixed
  word target.
- **`balanced`**: The default. Keeps important details, conditions, warnings,
  context, code, and formatting while trimming fluff and repetition.
- **`faithful`**: Simplifies the language while preserving every claim,
  qualification, warning, number, command, code block, and formatting choice.

### Modal controls

- **Mouse wheel / trackpad**: Scroll in regular or fullscreen mode
- **↑ / ↓**: Scroll in any mode
- **PgUp / PgDn**: Scroll a page at a time (also in btw)
- **C** or `/copy`: Copy the complete result
- **R**: Retry the same captured source
- **M**: Re-simplify the captured source in the next mode (brief → balanced → faithful → brief), without changing the saved default
- **O**: Open the browser diagram when a `/show` result has one
- **Esc**: Return from help to the saved result, or close (and cancel any active request)

Use the single-letter shortcuts with the composer empty.

The modal header shows the model and reasoning effort the explanation or
drawing used (`default` when the model's own effort applies), followed by the
explanation mode, and `prefs` when your [preferences](../reference/settings.md#preferences) shaped the
result; reopening Simplify keeps the original labels, mode, and tag.

Bro temporarily captures mouse input while its modal is open. Native mouse
selection may be unavailable or visually extend outside the modal depending on
your terminal mode; press **C** to copy the complete explanation reliably.

## Explain pasted text

Paste text directly after the command:

```text
/bro simplify text OAuth refresh tokens are rotated after every successful use.
```

Inside Simplify, use `/text <text>` for the same action. Press **R** to simplify the same captured text again.

## Explain a document

Use a relative or absolute path, including files outside Pi's current workspace. Symlinks are followed; normal OS file permissions apply:

```text
/bro simplify file "docs/incident review.pdf"
```

Paths may contain spaces; matching single or double quotes are also accepted.
Bro extracts text locally, then sends that text through the same explanation
flow used by `/bro`. Pressing **R** retries the extracted snapshot; running a
new `/file <path>` command inside Simplify (or `/bro simplify file <path>` directly) reads it again.

Files are limited to 10 MiB and 100,000 extracted characters. Scanned PDFs are
not supported because Bro does not perform OCR.

## Explain a webpage

Pass one public HTTP or HTTPS page:

```text
/bro simplify url https://example.com/complicated-article
```

Bro fetches the page, extracts its main readable text locally, and sends only
that text through the existing explanation flow. The completed modal shows the
final website and page title. Pressing **R** retries the captured page without
fetching again; running `/url <url>` inside Simplify fetches a fresh copy.

The first version is intentionally limited to one public, text-based page. It
does not use browser cookies, sign in, run page JavaScript, bypass paywalls or
bot protection, load complete discussion threads, follow pagination, or
understand images and video. Pages that depend on those features may fail.

If Bro cannot read a page, copy its content into a `.txt` or `.md` file, or save
it as a PDF, then use `/bro simplify file <path>`.
