import path from "node:path";

/**
 * Where a media input comes from, decided from the text the user passed with `-m`.
 */
export type MediaSource =
    | { kind: "youtube"; url: string }
    | { kind: "remote"; url: string }
    | { kind: "file"; path: string }
    | { kind: "invalid"; reason: string };

const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
]);

/** MIME types Gemini documents for video and audio input. */
const MIME_BY_EXTENSION: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mpeg": "video/mpeg",
    ".mpg": "video/mpg",
    ".mov": "video/mov",
    ".avi": "video/avi",
    ".flv": "video/x-flv",
    ".webm": "video/webm",
    ".wmv": "video/wmv",
    ".3gp": "video/3gpp",
    ".3gpp": "video/3gpp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".aiff": "audio/aiff",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/m4a",
    ".opus": "audio/opus",
};

/**
 * Classifies a `-m` value. Anything starting with `http(s)://` is a URL (YouTube or other);
 * everything else is a local file path resolved against the current directory.
 */
export function classifyMedia(raw: string): MediaSource {
    const value = raw.trim();
    if (!/^https?:\/\//i.test(value)) {
        return { kind: "file", path: path.resolve(value) };
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return { kind: "invalid", reason: "not a valid URL" };
    }
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase())
        ? { kind: "youtube", url: value }
        : { kind: "remote", url: value };
}

/**
 * Picks the MIME type for a local file. `override` (from `--mime`) always wins.
 *
 * @returns The MIME type, or `undefined` when the extension is not a known media type.
 */
export function mimeTypeFor(
    filePath: string,
    override?: string
): string | undefined {
    if (override) return override;
    return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

/**
 * Whether a MIME type is audio-only. Audio-only input cannot use agentic video processing.
 */
export function isAudioMime(mimeType: string): boolean {
    return mimeType.startsWith("audio/");
}
