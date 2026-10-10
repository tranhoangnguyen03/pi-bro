# Guided Review live testing

The simulated `/review-demo` launcher has been retired. Use the production command:

```sh
pi --tui-mode fullscreen --no-extensions -e ./bro.ts
```

Then `/bro guided-review https://github.com/tranhoangnguyen03/pi-bro/pull/102`.

This uses authenticated `gh`, captures source outside the active workspace, and makes real calls with the configured review backend. Opening the same PR restores its captured review without generation; bare `/bro guided-review` lists saved reviews. Capture/preparation of a new PR, sending questions and confirmed regeneration make calls. Set a call budget first; do not automatically retry. Nothing is published. For a smaller development-only entry, `dev/review-live.ts` registers `/review-live` against the production controller, but passes empty preferences and is not covered by the normal typecheck. Use `bro.ts` when checking production behavior.

For isolated manual checks set `PI_CODING_AGENT_DIR` to a temporary directory and put a valid `bro-settings.json` there; this avoids changing normal settings/reviews. The recorded PR fixture in `review-demo-source.json` remains available as source data only, not a separate UI or answer generator.

Current behavior/scope: [Guided Review](../docs/guided-review.md). Reproducible manual checks: [TESTING](../docs/TESTING.md#guided-review). Historical live evidence: [initial PR run](../docs/plans/2026-10-08-guided-review-live-check.md) and [bounded qualification](../docs/plans/2026-10-10-guided-review-live-qualification.md). Temp scripts/logs in those records are evidence from that machine, not portable launch instructions.
