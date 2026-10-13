# PiG support implementation plan

**Goal:** Keep one package for Pi and PiG 0.3.0, with explicit host-boundary verification and documented limitations.

**Architecture:** Use the existing public `getAgentDir()` and custom UI terminal geometry APIs. Keep backend execution and session projection unchanged. Pin the released PiG binary for a separate CI/release check; never hide its RPC exclusion defect behind a Bro availability workaround.

**Steps (direct execution, no publishing):**
1. Add real-host path isolation regression and terminal geometry assertions; reproduce failures.
2. Change `bro.ts` to use `getAgentDir()` and `tui.terminal.rows`.
3. Adapt `smoke-test.sh` for isolated PiG directories, preserving Pi assertions and a strict, version-specific expected failure for PiG 0.3.0 RPC exclusion.
4. Add a checksum-verified pinned PiG installer and CI/release job; reuse existing smoke coverage.
5. Exercise real-host session projection, advisor execution with fake backend, and interactive config/steering/cancellation. Document evidence and limits, including RPC exclusion and clipboard/mouse behavior.
6. Run `npm test`, PiG checks, inspect diff; leave changes uncommitted and unpublished.
