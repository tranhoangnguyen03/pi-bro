# Explain text, files and webpages

[Docs home](../README.md) · [All commands](../reference/commands.md) · [Safety and permissions](../reference/data-and-permissions.md)

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
- **C**: Copy the complete explanation
- **R**: Simplify the captured source again in the mode shown, or run the
  current Doctor check again
- **M**: Re-simplify the captured source in the next mode (brief → balanced →
  faithful → brief). It applies to this explanation only and does not change
  the mode saved by `/bro mode`; pressing it again while Bro is working skips
  ahead
- **O**: Open the diagram (an HTML layout or a rendered sequence diagram) when a show reply contains one
- **Esc**: Close the modal, or cancel while Bro is working

The modal header shows the model and reasoning effort the explanation or
drawing used (`default` when the model's own effort applies), followed by the
explanation mode, and `prefs` when your [preferences](../reference/settings.md#preferences) shaped the
result; `/bro open` keeps the original labels, mode, and tag.

Bro temporarily captures mouse input while its modal is open. Native mouse
selection may be unavailable or visually extend outside the modal depending on
your terminal mode; press **C** to copy the complete explanation reliably.

## Explain pasted text

Paste text directly after the command:

```text
/bro text OAuth refresh tokens are rotated after every successful use.
```

Bro explains the pasted text instead of the latest assistant reply. With no text
after `/bro text`, it falls back to the latest completed reply. Press **R**
to simplify the same captured text again.

## Explain a document

Use a path relative to Pi's current workspace, or an absolute path inside it:

```text
/bro file "docs/incident review.pdf"
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
