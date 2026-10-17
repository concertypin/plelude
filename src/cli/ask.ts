import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import * as z from "zod";

import { ASK_HELP } from "@/cli/help";
import {
    analyzeWith,
    EXIT,
    formatUsage,
    type CliDeps,
    type ExitCode,
} from "@/cli/shared";
import { buildParams, resolveMedia, streamAnalysis } from "@/core/analyze";
import { keyFingerprint } from "@/core/cache";
import { readConfigFile, resolveApiKey } from "@/core/config";
import type { MediaSource } from "@/core/media";
import { planAsk, type AskInput } from "@/core/options";
import { uploadCacheFilePath } from "@/core/paths";

const ASK_OPTIONS = {
    media: { type: "string", short: "m", multiple: true },
    continue: { type: "string", short: "c" },
    model: { type: "string" },
    mode: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    fps: { type: "string" },
    "thinking-level": { type: "string" },
    resolution: { type: "string" },
    system: { type: "string" },
    schema: { type: "string" },
    "max-tokens": { type: "string" },
    ephemeral: { type: "boolean" },
    grounding: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
} as const;

/**
 * A parsed `ask` command line, before validation of its values.
 */
export interface ParsedAsk {
    help: boolean;
    questionArg: string | undefined;
    input: AskInput;
    schemaPath: string | undefined;
    json: boolean;
}

const schemaSchema = z.record(z.string(), z.unknown());

/**
 * Parses `ask` arguments. Unknown flags, repeated positionals, and non-numeric numbers are rejected.
 */
export function parseAskArgs(
    args: readonly string[]
): { ok: true; value: ParsedAsk } | { ok: false; error: string } {
    let values: ReturnType<typeof readValues>;
    try {
        values = readValues(args);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const { flags, positionals } = values;
    if (flags.help) return { ok: true, value: emptyParse({ help: true }) };

    const fps = toNumber(flags.fps, "--fps");
    if (!fps.ok) return fps;
    const maxTokens = toNumber(flags["max-tokens"], "--max-tokens");
    if (!maxTokens.ok) return maxTokens;

    if (positionals.length > 1) {
        return {
            ok: false,
            error: `expected one question but got ${positionals.length} positional arguments. Quote the question, and pass each file with -m (for example: plelude ask "question" -m a.mp4 -m b.mp4)`,
        };
    }

    return {
        ok: true,
        value: emptyParse({
            help: false,
            questionArg: positionals[0],
            input: {
                media: flags.media ?? [],
                continueFrom: flags.continue,
                model: flags.model,
                mode: flags.mode,
                start: flags.start,
                end: flags.end,
                fps: fps.value,
                thinkingLevel: flags["thinking-level"],
                resolution: flags.resolution,
                system: flags.system,
                maxTokens: maxTokens.value,
                ephemeral: flags.ephemeral ?? false,
                grounding: flags.grounding ?? false,
            },
            schemaPath: flags.schema,
            json: flags.json ?? false,
        }),
    };
}

function readValues(args: readonly string[]) {
    const parsed = parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        options: ASK_OPTIONS,
    });
    return { flags: parsed.values, positionals: parsed.positionals };
}

function emptyParse(overrides: Partial<ParsedAsk>): ParsedAsk {
    return {
        help: false,
        questionArg: undefined,
        input: { media: [] },
        schemaPath: undefined,
        json: false,
        ...overrides,
    };
}

function toNumber(
    raw: string | undefined,
    flag: string
): { ok: true; value: number | undefined } | { ok: false; error: string } {
    if (raw === undefined) return { ok: true, value: undefined };
    const value = Number(raw);
    return Number.isFinite(value) && raw.trim() !== ""
        ? { ok: true, value }
        : { ok: false, error: `${flag} must be a number, got "${raw}"` };
}

/**
 * Runs `plelude ask` and returns the exit code.
 */
export async function runAsk(
    args: readonly string[],
    deps: CliDeps
): Promise<ExitCode> {
    const parsed = parseAskArgs(args);
    if (!parsed.ok) return usage(deps, parsed.error);
    if (parsed.value.help) {
        deps.write(ASK_HELP);
        return EXIT.ok;
    }

    const { questionArg, input, schemaPath, json } = parsed.value;
    if (questionArg === undefined) {
        return usage(
            deps,
            "a question is required. Quote it, or pass - to read it from stdin"
        );
    }
    const question =
        questionArg === "-" ? (await deps.readStdin()).trim() : questionArg;

    const plan = planAsk({ ...input, question });
    if (!plan.ok) return usage(deps, plan.error);

    const missing = plan.value.sources.find(
        (source): source is Extract<MediaSource, { kind: "file" }> =>
            source.kind === "file" && !existsSync(source.path)
    );
    if (missing) {
        return usage(
            deps,
            `media file not found: ${missing.path} (relative paths are resolved from the current directory)`
        );
    }

    let responseSchema: Record<string, unknown> | undefined;
    if (schemaPath !== undefined) {
        try {
            responseSchema = schemaSchema.parse(
                JSON.parse(readFileSync(schemaPath, "utf8"))
            );
        } catch (error) {
            return usage(
                deps,
                `--schema ${schemaPath} must be a JSON object: ${errorText(error)}`
            );
        }
    }

    const config = readConfigFile(deps.env);
    const key = resolveApiKey(deps.env);
    if (!key) return noKey(deps);

    return analyzeWith(
        { deps, json, apiKey: key.apiKey, baseUrl: config.baseUrl },
        async (port) => {
            const inherited = plan.value.continueFrom
                ? await port.getInteraction(plan.value.continueFrom)
                : undefined;
            const { media, cleanup } = await resolveMedia(plan.value.sources, {
                port,
                cache: {
                    file: uploadCacheFilePath(deps.env),
                    fingerprint: keyFingerprint(key.apiKey),
                    nowMs: deps.now(),
                },
            });
            // Uploads are finished by now, so temporary downloads are no longer needed.
            await cleanup();
            const params = buildParams(plan.value, media, {
                defaults: config,
                inherited,
                responseSchema,
            });
            return {
                events: streamAnalysis(port, params, {
                    apiKey: key.apiKey,
                    retryEmpty: plan.value.maxTokens === undefined,
                    retryDelayMs: 1000,
                }),
                ephemeral: plan.value.ephemeral,
            };
        }
    );
}

function usage(deps: CliDeps, message: string): ExitCode {
    deps.write(formatUsage(message));
    return EXIT.usage;
}

function noKey(deps: CliDeps): ExitCode {
    deps.write(
        "[plelude] error: no Gemini API key. Set GEMINI_API_KEY, or run: plelude config set apiKey (reads the key without echo)\n"
    );
    return EXIT.noKey;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
