# Architecture writing and diagrams

The index explains the project's purpose, most important boundaries, and a reading path to useful details. Prefer meaningful nouns and verbs to framework jargon.

A useful architecture explanation answers: What starts this? What owns this step? What does it depend on? What changes as a result? Where would a maintainer modify it? Which assumptions remain unverified?

## Views

- **Overview map:** components with distinct responsibilities and labelled communication edges. Do not draw every file.
- **Flow or sequence:** where order, handoff, retries or termination matter. Verify each step from the source.
- **Data lineage:** datasets, transformations and consumers, with schedules/quality/recovery if shown.
- **Deployment:** only for meaningful runtime boundaries supported by infra configs.
- **Decision context:** cite accepted ADRs/issues; do not reconstruct rationale solely from implementation.

Keep diagrams legible. Multiple focused diagrams beat one unreadable wall. Show relationships at the level a reader needs and link to the relevant path in the index. When extra Mermaid diagrams help, return `diagrams/<name>.mmd`; keep the diagram text consistent with the graph and prose.

The generated interactive HTML is built by the host from `architecture.graph.json`. Do not hand-code or return `architecture.html`. Link to it from README.

Use relative paths that work in GitHub as well as local files. If a feature has no credible source, mark the knowledge gap rather than presenting a guess. Remove duplicate explanations; link from one page to the authoritative section.
