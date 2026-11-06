# Generate architecture docs

`/bro architecture` inspects your current project and creates or improves `docs/architecture/`. No template selection or onboarding questions are needed.

```text
/bro architecture
/bro architecture Explain the background task and recovery path
```

Bro uses the **BTW-selected backend, model and effort** (choose them in `/bro config`). Architecture Docs appears under Features as an inherited workflow, not another model override. It sends a source snapshot to that backend, using the same restricted inspection tools as Guided Review. The command is not a side conversation or a PR review, and it never posts text into the main Pi chat.

## What it makes

- `docs/architecture/README.md`: an overview and reading order.
- `docs/architecture/architecture.graph.json`: editable information about important components and connections.
- `docs/architecture/architecture.html`: the offline interactive map, generated from the JSON (no remote scripts, CDN or server).
- Additional Markdown guides and editable Mermaid diagrams only when the project calls for them.

Bro looks for existing architecture docs first. A second run should keep useful writing, update changed descriptions and revise diagrams. It does **not** silently delete existing pages or edit source code. An optional focus narrows the investigation; it does not create a new documentation mode.

The graph shows responsibilities, not every file. Claims should point to real repo-relative paths, and unknowns should be named. The map's links point to the source and related guides. Cycles remain visible; feedback arrows stay outside component boxes and downstream components retain their own columns.

After a successful run, **O** opens the generated HTML using Bro's existing browser action, **C** copies the report, and **R** starts a fresh documentation run. The result retains its model and preferences indicator.

## How it works and what changes

Bro copies non-ignored, readable project files into a temporary working directory. It skips symlinks, obvious credential files, binaries and very large files. Existing architecture docs get priority in the snapshot budget. Bro separately records existing documentation hashes, including omitted assets and large generated HTML, so omission does not look like a concurrent new file. The displayed inventory and omitted-file list help the model avoid inventing what it could not inspect.

The selected backend inspects that **temporary source copy**. Claude, Muse and Pi use file-only inspection; Codex and Grok can run shell in read-only sandboxes; **Agy may write inside the temporary copy**. The temporary copy is not an operating-system sandbox; a CLI's broader local or network access is controlled by that CLI, not Bro.

The model only returns a JSON **proposal**. Bro validates paths, graph links, source references and generated HTML, then writes the resulting files under `docs/architecture/`. Markdown link checks ignore code examples and do not parse Mermaid as Markdown. Legitimate links to omitted images, PDFs and other files resolve against the original repo without copying their bytes into model context. References to temporary support files and symlink escapes are refused.

If a live input or target changed since the copy was made, Bro refuses stale overwrites. Import runs in-process with cooperative cancellation: closing the modal signals a stop, and the command waits for rollback before settling. It does not kill a subprocess that might have replaced only some files. New documentation uses normal umask permissions; refreshed files retain their existing permissions. A failed import attempts rollback without overwriting another writer's newer content. Abrupt host shutdown, filesystem failures during rollback, and concurrent external writers are not a multi-file transaction guarantee; failures are reported rather than labelled successful.

Bro does not commit, push, run project tests, execute code from the repository, install dependencies, or start a background watcher. The generated diagram is an explanation, not proof of runtime behavior. Broken links and malformed graph references are checked automatically, but the model remains responsible for its factual interpretation; examine important claims before relying on them.

## Limits and manual check

A very large repository, skipped source file, unsupported backend model or invalid model response may stop the job. The command reports the error rather than silently changing providers or writing unchecked docs. Generated text goes to your selected provider; the backend's own retention policy applies.

To evaluate output, open the Markdown index and `architecture.html` offline, follow a real entry-to-result flow and check the source paths. Try a second run after changing behavior inside a function without changing its name. Ensure the docs reflect the change and still agree with the diagram. See [backend safety](../reference/data-and-permissions.md#architecture-docs) and [manual verification](../TESTING.md#architecture-docs).
