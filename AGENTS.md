# AGENTS.md

Guidance for AI agents working in this repository. Claude Code and other agents should read it before changing code.

## What this is

`plelude` is a command-line tool. It sends video, audio, or YouTube media to Gemini and prints the answer as plain text on stdout, so agents without native media input can use it. The same core is also a library (`src/index.ts`).

## Layout

```
src/
  index.ts            library exports
  cli/
    bin.ts            executable entry (built with a node shebang)
    main.ts           command dispatch: ask, upload, config
    ask.ts            `ask` argument parsing and flow
    upload.ts         `upload`
    config-command.ts `config set|get|unset|path`
    shared.ts         exit codes, CliDeps, and the [plelude] output loop
    help.ts           help text (agent-facing; keep it accurate)
    prod.ts           real stdin/stdout/terminal wiring
    version.ts        VERSION, checked against package.json by a test
  core/
    options.ts        planAsk: validates ask input into an AskPlan
    media.ts          classify -m values; MIME types
    analyze.ts        build input/params, resolve media, stream with retries
    gemini.ts         the GeminiPort (SDK adapter) and zod-checked reads
    remote.ts         HEAD probe and download for remote URLs
    cache.ts          upload cache (files.json), keyed by key fingerprint
    config.ts         config.json, API key resolution
    paths.ts          ~/.config/plelude locations
tests/unit/           vitest; fakes for Gemini, fetch, and stdin/stdout
scripts/probe-gemini.ts   manual probe against the live API (see below)
```

## Commands

- `pnpm run check`: format, lint (type-aware), tests. Run this before every commit.
- `pnpm build`: builds `dist/`, including `dist/cli/bin.js`.
- `node dist/cli/bin.js ask "..." -m clip.mp4`: runs the built CLI against the real API. It uses the key from `~/.config/plelude/config.json` or `GEMINI_API_KEY`.
- `pnpm exec vitest run <file>`: one test file.

## Conventions

- Output: stdout only. Every line the agent may read starts with `[plelude]` except the streamed answer. Do not write to stderr, except the terminal-only key prompt.
- Exit codes are part of the interface (`EXIT` in `src/cli/shared.ts`): 0 ok, 1 Gemini, 2 usage, 3 no key.
- Never print the API key. Errors pass through `redactKey`. Never accept the key as a command-line argument.
- Never use `as` casts (except `as const`). Parse external data with zod.
- Use `import * as z from "zod"`. Use `import type` for type-only imports.
- Keep side effects behind `CliDeps` / `GeminiPort` so tests can fake them.

## Gemini API facts (measured against the live API)

These differ from the docs in places. Check against the API again before changing them.

- Video `start_offset` and `end_offset` must be duration strings such as `"80s"`. Plain numbers are rejected with 400. This is the reverse of what the docs' examples show.
- Video resolution is set on the video part, as `resolution: "low"`. It is not allowed in `generation_config`, where `media_resolution` returns 400.
- `generation_config.max_output_tokens` works. Thinking tokens count against it, so a small limit can leave the answer empty.
- `background: true` requires `store: true` and cannot be used with audio input on the agent variants (`...-agent` returns 400). plelude does not use background. Every analysis streams in the foreground.
- Agentic video processing can invent speech from audio that has none. plelude prepends `AGENTIC_SYSTEM_INSTRUCTION` (in `src/core/analyze.ts`). Keep it unless you have re-measured.
- Follow-ups need `model`, `system_instruction`, `generation_config`, and `tools` sent again. plelude inherits them from `interactions.get`.
- `gemini-flash-lite-latest` is a Google-managed alias. Its target model can change.

## Probe script

`scripts/probe-gemini.ts` calls the real API with the key from the config file. It never prints the key. Steps are selected on the command line (`node scripts/probe-gemini.ts model upload create stream ...`). It keeps state in `.tmp/probe-state.json`. `.tmp/` is git-ignored.

Use it when a behavior is in doubt. Do not treat it as a test suite. Its checks cost quota.

## Do not

- Add background execution. It was removed on purpose.
- Add `--timeout`, `--no-wait`, or `result <id>`. They depend on background.
- Commit a real key, or write one into any file under the repository.
- Push, publish, or open a PR without the user's explicit permission. Work stays on `local/*` branches and is squash-merged into `dev/*` (see the `branching` skill).
- Lower the 100% line coverage on `src/core` without a reason written in the commit.
