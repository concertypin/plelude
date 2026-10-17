/**
 * Help text for the top-level command. Written for agents first: every flag that matters is listed
 * with an example, and the failure modes that are easy to hit are called out.
 */
export const MAIN_HELP = `plelude: analyze video and audio with Gemini and print text to stdout.

Usage:
  plelude ask "<question>" -m <media> [-m <media> ...] [options]
  plelude ask -c <session-id> "<question>" [-m <media> ...] [options]
  plelude upload <file|url>
  plelude config set <key> [value] | get <key> | unset <key> | path

Commands:
  ask       Analyze media. Prints the answer on stdout.
  upload    Upload a local file to Gemini ahead of time. Later runs reuse it for 48 hours.
  config    Store the API key and defaults in ~/.config/plelude/config.json.

Run "plelude ask --help" for the analysis options.

Output (stdout only; stderr is never used, except the hidden key prompt on a terminal):
  [plelude] session=<id>        printed as soon as the analysis starts
  <answer text, streamed>
  [plelude] done session=<id>   and the follow-up command
  [plelude] error: <message>    on failure; the exit code says what kind

Exit codes: 0 ok, 1 Gemini error, 2 usage error, 3 no API key.

Keys: GEMINI_API_KEY in the environment, or "plelude config set apiKey" (prompts without echo).
`;

/**
 * Help text for `plelude ask`.
 */
export const ASK_HELP = `Analyze video, audio, or YouTube media with Gemini.

Usage:
  plelude ask "<question>" -m <media> [-m <media> ...] [options]
  plelude ask -c <session-id> "<question>" [-m <media> ...] [options]

The question is one positional argument. Pass - to read it from stdin (useful for long prompts).
Media is given with -m, which can repeat. Each value is a local file, an http(s) URL, or a YouTube URL.
Relative file paths are resolved from the directory you run the command in.

Examples:
  plelude ask "What colors appear, and when?" -m clip.mp4
  plelude ask "Transcribe the speech word for word." -m interview.mp3
  plelude ask "Focus on 01:20-03:00 and summarize." -m lecture.mp4 --mode static --start 01:20 --end 03:00
  plelude ask -c v1_abc "And what about the second video?" -m other.mp4

Processing:
  Videos use agentic processing by default. The model navigates the timeline and loads only the
  parts it needs. It is the right choice for long videos and questions about specific moments.
  Use --mode static for short clips (a few minutes or less) where every frame or the exact sound matters.
  --start, --end and --fps only work with --mode static. For agentic, state the range in the prompt
  (for example: "focus on 01:20-03:00").
  Audio files (mp3, wav, ...) are sent directly and are unaffected by --mode.

Options:
  -m, --media <media>        Local file, http(s) URL, or YouTube URL. Repeatable.
  -c, --continue <id>        Continue a stored session. Model, system prompt, thinking level,
                             and grounding are inherited; flags given here override them.
      --model <name>         Model name. Default: gemini-flash-lite-latest.
      --mode <agentic|static>
      --start <time>         Static only. Seconds, MM:SS, or HH:MM:SS.
      --end <time>           Static only.
      --fps <number>         Static only. Frames per second to sample.
      --thinking-level <minimal|low|medium|high>
      --resolution <low|medium|high>   Media resolution (tokens per frame).
      --system <text>        Extra instruction, added after the built-in audio guidance.
      --schema <file.json>   Ask for JSON that matches this JSON Schema.
      --max-tokens <n>       Limit the answer length.
      --grounding            Let the model search Google and cite sources.
      --ephemeral            Do not store the session. Cannot be continued with -c.
      --json                 Print one JSON object instead of streamed text.
  -h, --help                 Show this help.

Sessions:
  Each run, and each follow-up with -c, gets its own session id. Continue from the id on the latest
  "done" line. Each run is stored by Google under your project's retention setting (paid projects can choose
  7, 14, 28 or 55 days in AI Studio; free projects keep 1 day). Continue a session with -c <session-id>.
  --ephemeral is never stored, so a dropped connection loses the answer and there is no id to resume.

Large files:
  Run "plelude upload <file>" first for big files. If the upload is interrupted you start it again
  from the beginning, so uploading separately keeps a retry cheap. Later "ask" runs reuse the upload.
`;
