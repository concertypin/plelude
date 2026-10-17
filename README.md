# plelude

Analyze video, audio, and YouTube media with Gemini from the command line. It prints plain text on stdout, so an agent that cannot read video or audio can run `plelude` and use the answer.

```bash
plelude ask "What colors appear, and when?" -m clip.mp4
```

```
[plelude] session=v1_...
Red for the first 3 seconds, then blue.
[plelude] done session=v1_...  follow-up: plelude ask -c v1_... "<question>"
```

## Running it

Not published yet. From a checkout, build once and run the built file. Every example below uses `plelude`; replace it with `node dist/cli/bin.js` until the package is installed as a command.

```bash
pnpm build
node dist/cli/bin.js ask "What colors appear, and when?" -m .tmp/red-blue.mp4
```

## Setup

Pick one:

- Set `GEMINI_API_KEY` in the environment, or
- Store the key once: `plelude config set apiKey`. It asks for the key without echo. You can also pipe it: `printf %s "$KEY" | plelude config set apiKey`.

The key is never accepted as a command-line argument, so it stays out of shell history. Settings live in `~/.config/plelude/config.json` (or `$XDG_CONFIG_HOME/plelude/`). On Unix the file is created with mode 600. On Windows, the file permissions are the default ones for your user profile.

Node 26 or later is required. Bun works as well.

## Commands

```
plelude ask "<question>" -m <media> [-m <media> ...] [options]
plelude ask -c <session-id> "<question>" [-m <media> ...] [options]
plelude upload <file|url>
plelude config set <key> [value] | get <key> | unset <key> | path
```

- `-m` takes a local file, an `http(s)` URL, or a YouTube URL. Repeat it for several files.
- `-c <id>` continues a stored session. New media can be added. The model, system prompt, thinking level, and grounding carry over; flags you pass override them.
- Pass `-` as the question to read it from stdin. Use this for long prompts.

Run `plelude ask --help` for every option, or `plelude --help` for the overview.

Relative `-m` paths are resolved from the directory you run the command in.

## Output

Everything goes to stdout. stderr is never used.

| Line                                          | Meaning                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `[plelude] session=<id>`                      | Printed as soon as the analysis starts. Each run (and each follow-up) gets its own id. |
| answer text                                   | Streamed as it arrives.                                                                |
| `[plelude] retry <n>: <reason>`               | A failed attempt was retried with a new session.                                       |
| `[plelude] done session=<id>  follow-up: ...` | The answer is complete.                                                                |
| `[plelude] error: <message>`                  | The analysis failed. The API key is never printed.                                     |

Everything is written to stdout. stderr is never used, except for the hidden API key prompt that `plelude config set apiKey` shows on a terminal.

With `--json`, stdout is one JSON object: `{"session", "text", "error"}`.

Exit codes: `0` success, `1` Gemini or network failure, `2` usage error, `3` no API key.

**Follow-ups create a new session.** `ask -c <id>` returns a new id for its own answer. Continue from the id on the most recent `done` line. The earlier id is not updated.

**Pipes hide failures.** `plelude ... | cat` reports the exit status of the last command in the pipeline, not of plelude. Either run with `set -o pipefail` (bash, zsh), or check stdout for a line starting with `[plelude] error:`.

## Processing modes

- **agentic (the default for every video).** The model navigates the timeline and loads only the parts it needs. It is the right choice for long videos and for questions about specific moments. Plelude always adds an instruction telling the model to listen to the actual audio rather than trusting automatic transcripts; without it, the model invented speech for clips with only tones.
- **static.** Frames are sampled at a fixed rate. Pick `--mode static` for short clips (a few minutes or less) where every frame or the exact sound matters. `--start`, `--end`, and `--fps` only apply in static mode. For agentic, state the range in the prompt instead.
- **Audio files** (mp3, wav, ...) are sent directly. `--mode` does not affect them.

## Storage and retention

- Every analysis is stored by Google so that follow-ups work. Retention depends on your project: paid projects can set 7, 14, 28, or 55 days in AI Studio; free projects keep 1 day.
- Uploaded files are kept by Gemini for 48 hours. Plelude remembers uploads in `~/.config/plelude/files.json`, so a file asked about again is not uploaded again while the upload is valid. The file stores the local path, size, and modification time, plus a hash of your key. It never stores the key itself.
- `--ephemeral` does not store the analysis. It cannot be continued, and a dropped connection loses the answer.

## Large files

Run `plelude upload <file>` first for big files. If an upload is interrupted, it starts again from the beginning, so uploading separately makes a retry cheap. Later `ask` runs on the same file reuse the upload.

Remote URLs of 15 MB or less are passed to Gemini by URL. Larger ones are downloaded to a temporary directory and then uploaded.

## Limits and known behavior

- The CLI does not check file sizes against any limit. Gemini enforces its own limits, and its documentation gives different Files API numbers in different places (2 GB and 20 GB). The only size rule plelude applies is the 15 MB threshold for passing a remote URL directly rather than downloading it.
- YouTube URLs are a preview Gemini feature. Free keys are limited to 8 hours of YouTube video per day.
- Background execution is not used. A request streams from start to finish, so a dropped connection ends the analysis. Retries happen only before any text has been printed.
- `--grounding` cannot be turned off on a follow-up if the session started with it.
- The model can still make mistakes on quiet audio or dense speech. Check important answers against the source.

## Development

See [AGENTS.md](AGENTS.md) for layout, commands, and the live probe script.
