# rayban-meta-freedom

Make a provisioned Ray-Ban Meta companion **programmable** — without disturbing
its existing connection, pairing, or transport. The goal is to keep the stock
pairing and on-air protocol intact while inserting replaceable, phone-side
feature handlers for capture/media, AI, audio, settings, and device events.

> **Status: research, in active development (beta).** This is a reverse-engineering
> and instrumentation project. Parts of it work, parts are proven only in a lab
> rig, and parts are still being built. Treat every result as provisional and
> verify on your own hardware. Feedback and contributions are welcome — see
> *Contributing* and *License* below.

## What works today

- **Talk to the AI assistant from anywhere — including regions where it is
  normally blocked.** The assistant path can be routed to a configurable,
  self-hosted or third-party endpoint, so the voice assistant works even where
  the official service is geofenced off. This is the most mature part of the
  project.
- **Protocol capture and decode.** Framework-level BLE/DataX capture above the
  on-air encryption, plus a generic protobuf wire decoder, recover the
  service/opcode map that static analysis alone could not.
- **A no-root research build.** A Frida-Gadget repack of the companion runs the
  handlers on an unrooted research device, and a host-side runner attaches to it.
- **Replaceable handlers, off by default.** Capture/media, audio/TTS, settings,
  and event handlers are modular and ship disabled; you opt each one in by
  configuration.

## In progress

The following are **not yet fully working** and are under active development:

- **Vision / camera-to-AI** — sending a captured image to the assistant for a
  visual answer. Partially wired, not yet reliable end-to-end.
- **Photo/media import redirection** — routing captured media to your own sink.
- **Wake word and audio playback** replacement on the glasses.
- **Full independent host** — driving the glasses without the official companion.

Anything not listed under *What works today* should be assumed incomplete.

## Layout

- `tools/frida/` — capture and control scripts (BLE/DataX capture, TLS unpin,
  device control).
- `tools/patch/` — the replaceable phone-side feature handlers and their router.
- `tools/driver/` — host-side recon and a protobuf decoder.
- `tools/mitm/` — OTA/traffic capture addon.
- `tools/tts-test-app/` — a small standalone Android app for audio-path testing.
- `tests/` — Node-based unit tests for the handlers (`node --test tests`).
- `tools/README.md` — how to run the capture and build rigs.

## Scope

Firmware replacement and a custom on-glasses UI are **out of scope**. The project
deliberately preserves the stock firmware, pairing, and transport, and only
replaces phone-side behavior.

## Safety and data

Captures, APKs, firmware, and keys can contain personal data (account IDs,
device serials, tokens, private media) and are **never** committed — see
`.gitignore`. Never place a credential, key, or private media into source, a log,
or a commit. Handlers stay off by default; queued media is capped; no blind
fallback runs after a replacement side effect.

Use this only on hardware and accounts you own, and in compliance with the
applicable terms and local law.

## Contributing

This is a personal project shared for study and collaboration. Improvements are
welcome as contributions **back into this repository** (issues and pull
requests). Please do not maintain public forks — see the license.

## License

Personal, non-commercial use only. See [LICENSE](LICENSE). In short: you may use
and study the code and submit changes back here; no public forking, no
redistribution, and no commercial use without written permission.
