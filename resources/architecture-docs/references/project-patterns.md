# Investigating different project types

Use only the questions that fit the observed project. A single repository may contain several types.

## CLI or library

Find the public commands/functions, argument parsing, module boundaries, main execution path, side effects, errors, extension points, and tests showing contract. Distinguish API from internal helpers. Trace one real call from caller to result.

## App or service

Find the user entry points, routes/handlers, internal services, data/storage, queues/jobs, auth/trust boundaries, and external dependencies. Trace a representative success path and a meaningful error/retry path. Draw network boundaries only when supported by configuration or code.

## Data / analytics / ML

Find source systems, datasets, ingestion method, transform definitions (SQL, dbt, notebooks), lineage, orchestration, refresh schedule, quality tests, storage layers, and consumers. Explain material transformations in domain language. Differentiate inferred lineage from declared dependencies. A DAG graph is not necessarily a runtime guarantee.

## Agent / plugin / automation

Find commands/events/tools, context and prompt construction, model/backend selection, tool permissions, delegation, persistence, cancellation, recovery, external calls and outputs. Trace one ordinary and one interrupted interaction. State the difference between an instruction to the model and a host-enforced boundary.

## Infrastructure / deployment

Find configuration entry points, deploy units, networking, storage, secrets *roles* (never values), CI/release flows, scheduled work, ownership and failure/recovery controls. Describe what configuration proves; do not infer production deployment from a template alone.

## Code-adjacent / specification only

Read the approved requirements, plans and design choices. Document the proposed structure and trace future interactions as **planned**. List unresolved design questions. Do not invent implemented files, APIs or observed runtime behavior.

## Mixed repositories

Pick top-level boundaries by deployable units, independent responsibilities, or shared data contracts. Add deeper views where necessary; avoid copying every directory into the map. Name cross-boundary messages, data and side effects.
