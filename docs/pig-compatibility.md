# PiG compatibility

Bro uses one TypeScript package on Pi and Pi-in-Go (PiG). PiG runs Bro in a Node subprocess; it is not a Go port or a fused native extension.

## Target and installation

PiG **0.3.0+0.87.1**, Node **>=22.19.0**. Compatibility is experimental; the checks below are not a guarantee for every PiG release or platform.

Install the PiG binary from https://github.com/MichaelKinsy/PiG/releases/tag/v0.3.0, then:

```sh
pig install npm:pi-bro
```

That command installs the published Bro version; these compatibility changes take effect only after a Bro release containing them. To test this checkout now, install dependencies and use `pig -e ./bro.ts`.

At initial verification, `@pi-in-go/pig@0.3.0` was not available from npm. CI therefore downloads the pinned GitHub binary and verifies its published SHA-256 checksum.

Bro follows the host's `getAgentDir()`: normally `~/.pi/agent` on Pi and `~/.pig/agent` on PiG. PiG supports `PIG_CODING_AGENT_DIR`, `PIG_HOME`, XDG configuration and explicit `PIG_USE_PI_DIRS=1` sharing. No automatic migration or copying of existing Bro settings takes place. `PI_BRO_MODEL` remains the same Bro-specific override on both hosts.

## Known limitations

- **PiG 0.3.0 RPC does not enforce `--exclude-tools`.** Excluded tools may remain active and reach provider requests. This is not a sandbox boundary. Use an explicit `--tools` allowlist instead; do not rely on `/bro doctor` to prove exclusion. Bro does not mask this defect by falsely reporting an active tool as unavailable.
- The smoke suite retains Pi's strict exclusion assertion. The PiG lane has an explicit version-specific expected failure; a changed result fails the lane so the exception must be reviewed/removed.
- Mouse-wheel forwarding is not qualified; use keyboard scrolling.
- Remote/SSH OSC 52 clipboard forwarding is not qualified. Local clipboard behavior depends on the host and installed platform utilities.
- Windows support is not qualified by these checks.

## Verification and release gate

```sh
npm test
PIG_BIN=/absolute/path/to/pig sh pig-test.sh
```

The PiG lane checks the exact binary version, real host settings isolation, advisor snapshot compaction/branch projection, and the existing fake-backend RPC smoke suite. Existing Node tests cover backend cancellation/process cleanup and modal geometry, but are not substitutes for real-host interactive tests.

CI and publishing call `.github/workflows/pig.yml`; publication requires both host lanes. A green PiG job includes the clearly printed RPC exclusion expected failure, not a claim of complete parity.

Manual macOS terminal checks confirmed help rendering/scrolling/resize, opening the BTW composer and switching `/mode`, and the advisor-steering editor displaying `Saved` after a correctly encoded Ctrl+S. Full end-to-end advisor model execution, interactive configuration persistence, clipboard, and host reload/shutdown with active backend processes still require qualification. No paid backend calls are part of CI.

Tracking: https://github.com/tranhoangnguyen03/pi-bro/issues/64 and the original loading fix https://github.com/MichaelKinsy/PiG/issues/88.
