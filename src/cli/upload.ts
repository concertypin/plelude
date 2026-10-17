import { existsSync } from "node:fs";

import { EXIT, formatUsage, type CliDeps, type ExitCode } from "@/cli/shared";
import { resolveMedia } from "@/core/analyze";
import { keyFingerprint } from "@/core/cache";
import { readConfigFile, resolveApiKey } from "@/core/config";
import { redactKey } from "@/core/gemini";
import { classifyMedia } from "@/core/media";
import { uploadCacheFilePath } from "@/core/paths";

const UPLOAD_HELP = `Usage: plelude upload <file|url>

Uploads a local file to Gemini and prints its URI. The upload is kept for 48 hours, and later
"plelude ask" runs on the same file reuse it. Use this for large files: an interrupted upload has to
start again from the beginning, so doing it separately makes a retry cheap.
`;

/**
 * Runs `plelude upload` and returns the exit code.
 */
export async function runUpload(
    args: readonly string[],
    deps: CliDeps
): Promise<ExitCode> {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        deps.write(UPLOAD_HELP);
        return args.length === 0 ? EXIT.usage : EXIT.ok;
    }
    if (args.length !== 1) {
        deps.write(formatUsage("upload takes exactly one file or URL"));
        return EXIT.usage;
    }
    const source = classifyMedia(args[0] ?? "");
    if (source.kind === "invalid") {
        deps.write(formatUsage(`invalid media: ${source.reason}`));
        return EXIT.usage;
    }
    if (source.kind === "file" && !existsSync(source.path)) {
        deps.write(formatUsage(`media file not found: ${source.path}`));
        return EXIT.usage;
    }

    const key = resolveApiKey(deps.env);
    if (!key) {
        deps.write(
            "[plelude] error: no Gemini API key. Set GEMINI_API_KEY, or run: plelude config set apiKey\n"
        );
        return EXIT.noKey;
    }
    const config = readConfigFile(deps.env);
    const port = deps.createPort({
        apiKey: key.apiKey,
        baseUrl: config.baseUrl,
    });

    try {
        const { media, cleanup } = await resolveMedia([source], {
            port,
            cache: {
                file: uploadCacheFilePath(deps.env),
                fingerprint: keyFingerprint(key.apiKey),
                nowMs: deps.now(),
            },
        });
        await cleanup();
        for (const item of media) {
            deps.write(
                `[plelude] uri=${item.uri}${item.mimeType ? ` mime=${item.mimeType}` : ""}\n`
            );
        }
        return EXIT.ok;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.write(`[plelude] error: ${redactKey(message, key.apiKey)}\n`);
        return EXIT.gemini;
    }
}
