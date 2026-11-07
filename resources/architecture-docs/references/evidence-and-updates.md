# Evidence, accuracy and refresh

Classify claims by what supports them:

- **Observed implementation:** code/config and a trace through relevant call sites.
- **Tested behavior:** an execution result observed during this run. Test definitions alone are not proof that a test passed.
- **Documented intent:** accepted spec, ADR, issue/PR decision; do not silently turn intent into implementation.
- **Unknown:** missing dependency, external contract, or a runtime side effect the repo cannot establish.

Source links use real paths relative to the repository root. Review any important relationship against the caller and callee, not only a matching name. Files can change behavior without changing function signatures.

On a refresh, inspect existing architecture docs before generating text. Compare them with the actual project, including changed function bodies, configuration and data definitions. Preserve useful and accurate text. Fix unsupported claims, broken links and stale diagrams. Keep human-authored rationale and history; when the code conflicts with an accepted decision, surface the mismatch instead of rewriting history.

Do not present generated text as verified merely because its JSON passes structural checks. The host's path and HTML checks do not establish runtime truth. Avoid reporting that tests ran or HTML rendered in a browser unless that happened.
