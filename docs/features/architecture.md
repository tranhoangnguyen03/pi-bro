# Generate architecture docs

`/bro architecture` inspects your current project and creates or improves `docs/architecture/`. No template selection or onboarding questions are needed.

```text
/bro architecture
/bro architecture Explain the background task and recovery path
```

Bro uses the **BTW-selected backend, model and effort** (choose them in `/bro config`). It sends a source snapshot to that backend, using the same restricted inspection tools as Guided Review. The command is not a side conversation or a PR review, and it never posts text into the main Pi chat.

## What it makes

- `docs/architecture/README.md`: an overview and reading order.
- `docs/architecture/architecture.graph.json`: editable information about important components and connections.
- `docs/architecture/architecture.html`: the offline interactive map, generated from the JSON (no remote scripts, CDN or server).
- Additional Markdown guides and editable Mermaid diagrams only when the project calls for them.

Bro looks for existing architecture docs first. A second run should keep useful writing, update changed descriptions and revise diagrams. It does **not** silently delete existing pages or edit source code. An optional focus narrows the investigation; it does not create a new documentation mode.

The graph shows responsibilities, not every file. Claims should point to real repo-relative paths, and unknowns should be named. The map's links point to the source and related guides.

## How it works and what changes

Bro copies non-ignored, readable project files into a temporary working directory. It skips symlinks, obvious credential files, binaries and very large files. The displayed inventory and omitted-file list help the model avoid inventing what it could not inspect. The selected backend sees that **temporary source copy**, not the live project. Anthropic/Claude, Muse and Pi use file-only inspection; Codex and Grok can run shell in read-only sandboxes; **Agy may write inside the temporary copy**. The temporary copy is not an operating-system sandbox; a CLI's broader local or network access is controlled by that CLI, not Bro.

The model only returns a JSON **proposal**. Bro validates its paths, document contents, graph links, source references and generated HTML, then writes the resulting files under `docs/architecture/`. If a live file or input source changed since the copy was made, Bro refuses to overwrite and suggests running the command again. Cancellation or a failed validation leaves existing project documents unchanged. A multi-file write is guarded and attempts rollback on failure, but abrupt host shutdown is not a transactional guarantee.

Bro does not commit, push, run project tests, execute code from the repository, install dependencies, or start a background watcher. The generated diagram is an explanation, not proof of runtime behavior. Broken links and malformed graph references are checked automatically, but the model remains responsible for its factual interpretation; examine important claims before relying on them.

## Limits and manual check

A very large repository, skipped source file, unsupported backend model or invalid model response may stop the job. The command reports the error rather than silently changing providers or writing partial docs. Generated text goes to your selected provider; the backend's own retention policy applies.

To evaluate output, open the Markdown index and `architecture.html` offline, follow a real entry-to-result flow and check the source paths. Try a second run after changing behavior inside a function without changing its name. Ensure the docs reflect the change and still agree with the diagram. See [backend safety](../reference/data-and-permissions.md#architecture-docs) and [manual verification](../TESTING.md#architecture-docs).
