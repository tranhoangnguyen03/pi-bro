# Diagnostics and troubleshooting

[Docs home](../README.md) · [All commands](commands.md) · [Safety and permissions](data-and-permissions.md)

## Check your setup

Run `/bro doctor` when Bro is newly installed or something is not working. It
checks Bro's settings and preferences, then probes only the backends some feature
actually selects, and reports the effective backend/model/effort for each
feature. Failed checks explain what to fix.

- **Agy**: installed version, model catalog, and account access.
- **Claude Code**: installed version and configured authentication.
- **Grok**: installed version only; authentication and connectivity are not
  verified.
- **Codex**: installed version and configured authentication.
- **Muse**: installed version only; authentication and connectivity are not
  verified.

Doctor never sends source text or runs a model completion. A successful check
confirms the setup but cannot guarantee that a later provider request will
succeed.

## Troubleshooting and current limits

If an explanation fails, run `/bro doctor` first. If a webpage cannot be
extracted, copy its content into a supported text file or save it as a PDF and
use `/bro file`. If a PDF contains only scanned images, run OCR with another
tool before giving it to Bro.

- An unsupported model, effort, or missing backend fails with that backend's
  diagnostic; Bro never falls back to another backend.
- Document input supports `.md`, `.markdown`, `.txt`, `.pdf`, and `.docx` only;
  it does not perform OCR.
- Webpage input supports one public HTML page, up to 5 MiB downloaded and
  100,000 extracted characters. JavaScript-only, authenticated, paywalled,
  blocked, paginated, and media-first pages are not supported.
- Direct webpage fetching does not currently use `HTTP_PROXY`, `HTTPS_PROXY`,
  or other proxy environment variables.
- `/bro elevate` is pre-execution only. It does not validate expert claims, run source research or keep a persistent thread. Invalid discovery JSON can be retried with the [Retry] button; if it recurs, choose another BTW backend/model in `/bro config`. See [Elevate](../elevate.md).
- `/bro btw` threads are memory-only and do not survive reloads or restarts.
- The Agy advisor requires Agy CLI `>=1.1.15`.
- Show captures only the conversation text of what already happened in the
  current session — the last few turns' user and assistant messages, with
  tool calls, tool results, reasoning, and images always omitted; its shapes
  reflect what was reported in the conversation, not independent verification.
- Diagrams open in your default browser; pressing **O** on a remote or
  headless session with no display reports the failure instead of opening
  anything.
- Explain keeps only the latest result in memory and does not export directly to files. Guided Review separately persists review records and captured source.
- Guided Review is local-Pi interactive only, keeps its captured revision on reopen, and does not publish, review a branch or fetch later PR changes. See [review recovery and limits](../guided-review.md#if-something-goes-wrong).
- Bro temporarily captures mouse input while its modal is open so mouse-wheel
  and trackpad scrolling work in regular and fullscreen modes. Native mouse
  selection may be unavailable or visually extend outside the Bro window;
  press **C** to copy the full explanation instead.
