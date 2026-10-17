import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
    findUpload,
    readUploadCache,
    saveUpload,
    uploadCacheKey,
    type UploadCache,
} from "@/core/cache";
import type { PluginConfig } from "@/core/config";
import {
    redactKey,
    type GeminiPort,
    type InputPart,
    type InteractionParams,
    type InteractionView,
    type ToolSpec,
    type VideoProcessing,
} from "@/core/gemini";
import { isAudioMime, mimeTypeFor, type MediaSource } from "@/core/media";
import type { AskPlan, Resolution } from "@/core/options";
import {
    DIRECT_URL_LIMIT_BYTES,
    downloadRemote,
    probeRemote,
} from "@/core/remote";

export const DEFAULT_MODEL = "gemini-flash-lite-latest";

/**
 * Prepended to every agentic request. The agentic tool can return ASR text for audio that holds
 * no speech, and the model then invents words. This tells it to listen to the audio itself.
 */
export const AGENTIC_SYSTEM_INSTRUCTION = [
    "When the question involves sound, speech, music, or audio, load the actual audio with load_video using include_audio: true (together with include_frames if visuals matter) and listen to it.",
    "Do not rely on include_asr alone: ASR transcripts can contain invented words when the audio has no human speech (tones, music, sound effects).",
    "Only claim there is speech if you can hear a human voice in the loaded audio. If ASR text and the audio disagree, trust the audio.",
].join(" ");

/** A media input that Gemini can read by URI. */
export type ResolvedMedia =
    | { kind: "video"; uri: string; mimeType: string | undefined }
    | { kind: "audio"; uri: string; mimeType: string };

export type AnalysisEvent =
    | { type: "session"; id: string }
    | { type: "text"; text: string }
    | { type: "retry"; attempt: number; reason: string }
    | { type: "done"; id: string | undefined; text: string };

/** Thrown when an analysis fails and cannot be retried. */
export class AnalysisError extends Error {
    readonly code: string | undefined;

    constructor(message: string, code: string | undefined) {
        super(message);
        this.name = "AnalysisError";
        this.code = code;
    }
}

function videoProcessing(plan: AskPlan): VideoProcessing {
    if (plan.mode === "agentic") return "agentic";
    const { startSec, endSec, fps } = plan.clip;
    // The API takes offsets as duration strings ("80s"); plain numbers are rejected with 400.
    return {
        type: "static" as const,
        ...(startSec !== undefined ? { start_offset: `${startSec}s` } : {}),
        ...(endSec !== undefined ? { end_offset: `${endSec}s` } : {}),
        ...(fps !== undefined ? { fps } : {}),
    };
}

/**
 * Builds the `input` array. Media comes first and the question last, as the Gemini docs recommend.
 */
export function buildInput(
    plan: AskPlan,
    media: readonly ResolvedMedia[],
    resolution?: Resolution
): InputPart[] {
    const parts: InputPart[] = media.map((item) =>
        item.kind === "video"
            ? {
                  type: "video",
                  uri: item.uri,
                  ...(item.mimeType ? { mime_type: item.mimeType } : {}),
                  processing: videoProcessing(plan),
                  ...(resolution ? { resolution } : {}),
              }
            : { type: "audio", uri: item.uri, mime_type: item.mimeType }
    );
    parts.push({ type: "text", text: plan.question });
    return parts;
}

/**
 * Builds the request. A follow-up (`-c`) inherits model, system instruction, generation config and
 * tools from the parent interaction, because the Interactions API does not carry them over.
 * Flags given on the follow-up override what was inherited.
 */
export function buildParams(
    plan: AskPlan,
    media: readonly ResolvedMedia[],
    options: {
        defaults: Pick<PluginConfig, "model" | "thinkingLevel" | "resolution">;
        inherited: InteractionView | undefined;
        responseSchema?: Record<string, unknown> | undefined;
    }
): InteractionParams {
    const { defaults, inherited } = options;

    const generationConfig: Record<string, unknown> = {
        ...inherited?.generationConfig,
    };
    const thinking =
        plan.thinkingLevel ?? (inherited ? undefined : defaults.thinkingLevel);
    if (thinking) generationConfig.thinking_level = thinking;
    if (plan.maxTokens !== undefined)
        generationConfig["max_output_tokens"] = plan.maxTokens;

    const agenticBase =
        plan.mode === "agentic" ? AGENTIC_SYSTEM_INSTRUCTION : undefined;
    const systemInstruction =
        plan.system !== undefined
            ? [agenticBase, plan.system]
                  .filter((part) => part !== undefined)
                  .join("\n\n")
            : (inherited?.systemInstruction ?? agenticBase);

    const grounded: ToolSpec[] = [{ type: "google_search" }];
    const tools = plan.grounding ? grounded : inherited?.tools;

    return {
        model:
            plan.model ?? inherited?.model ?? defaults.model ?? DEFAULT_MODEL,
        store: !plan.ephemeral,
        input: buildInput(plan, media, plan.resolution ?? defaults.resolution),
        previousInteractionId: plan.continueFrom,
        systemInstruction,
        generationConfig:
            Object.keys(generationConfig).length > 0
                ? generationConfig
                : undefined,
        tools: tools && tools.length > 0 ? tools : undefined,
        responseFormat: options.responseSchema
            ? {
                  type: "text",
                  mime_type: "application/json",
                  schema: options.responseSchema,
              }
            : undefined,
    };
}

const MAX_ATTEMPTS = 3;

const EMPTY_ANSWER =
    "the model returned an empty answer (if --max-tokens is set, raise it: thinking counts against the limit)";

const STREAM_ENDED = "the answer stream ended before the model finished";

function isTransient(code: string | undefined, message: string): boolean {
    return code === "INTERNAL" || /high demand|try again later/i.test(message);
}

/**
 * Runs a streaming analysis and yields events as they arrive.
 *
 * A failed attempt is retried (with a new interaction, so a new session id) only when it produced no text yet,
 * because text already printed cannot be taken back. An empty answer is retried on the same condition.
 *
 * @throws {AnalysisError} When the analysis fails for good. The API key is redacted from the message.
 */
export async function* streamAnalysis(
    port: GeminiPort,
    params: InteractionParams,
    options: { apiKey: string; retryEmpty?: boolean; retryDelayMs?: number }
): AsyncGenerator<AnalysisEvent> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let sessionId: string | undefined;
        let text = "";
        let completed = false;
        let failure: { message: string; code: string | undefined } | undefined;

        try {
            for await (const event of port.streamInteraction(params)) {
                switch (event.kind) {
                    case "created":
                        sessionId = event.id;
                        if (params.store)
                            yield { type: "session", id: event.id };
                        break;
                    case "text":
                        text += event.text;
                        yield { type: "text", text: event.text };
                        break;
                    case "completed":
                        completed = true;
                        break;
                    case "error":
                        failure = {
                            message: redactKey(event.message, options.apiKey),
                            code: event.code,
                        };
                        break;
                }
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            failure = {
                message: redactKey(message, options.apiKey),
                code: undefined,
            };
        }

        if (completed && text.length > 0) {
            yield {
                type: "done",
                id: params.store ? sessionId : undefined,
                text,
            };
            return;
        }

        // An empty answer with no error is retried only when the caller allows it. With --max-tokens
        // set, the limit is usually what stopped the answer (thinking counts against it), so retrying
        // would just repeat the same result.
        const emptyAnswer = text.length === 0 && failure === undefined;
        const retryable =
            text.length === 0 &&
            (failure !== undefined
                ? isTransient(failure.code, failure.message)
                : emptyAnswer && (options.retryEmpty ?? true));
        const reason =
            failure?.message ?? (completed ? EMPTY_ANSWER : STREAM_ENDED);
        if (!retryable || attempt === MAX_ATTEMPTS) {
            throw new AnalysisError(reason, failure?.code);
        }
        yield { type: "retry", attempt, reason };
        // Back off before the next attempt: an overloaded model is usually still overloaded a few milliseconds later.
        await sleep((options.retryDelayMs ?? 0) * 2 ** (attempt - 1));
    }
}

/**
 * Turns the plan's media into references Gemini can read.
 *
 * - YouTube URLs are passed straight through.
 * - Remote URLs are passed through when the server reports them as at most 15 MB; otherwise they are
 *   downloaded and uploaded.
 * - Local files are uploaded, reusing a cached upload while it is still valid.
 *
 * @returns The resolved media and a `cleanup` that removes temporary downloads. Call it when done, even on failure.
 */
export async function resolveMedia(
    sources: readonly MediaSource[],
    deps: {
        port: GeminiPort;
        fetchFn?: typeof fetch;
        cache: { file: string; fingerprint: string; nowMs: number };
    }
): Promise<{ media: ResolvedMedia[]; cleanup: () => Promise<void> }> {
    const fetchFn = deps.fetchFn ?? fetch;
    const cleanups: (() => Promise<void>)[] = [];
    const cleanup = async (): Promise<void> => {
        for (const step of cleanups.splice(0)) await step();
    };

    let cache: UploadCache | undefined;
    const uploadLocal = async (
        filePath: string,
        mimeType: string
    ): Promise<{ uri: string; mimeType: string }> => {
        const stat = statSync(filePath);
        const key = uploadCacheKey({
            absPath: filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            fingerprint: deps.cache.fingerprint,
        });
        cache ??= readUploadCache(deps.cache.file);
        const cached = findUpload(cache, key, deps.cache.nowMs);
        if (cached) return { uri: cached.uri, mimeType: cached.mimeType };

        const file = await deps.port.uploadFile(filePath, mimeType);
        const entry = {
            name: file.name,
            uri: file.uri,
            mimeType: file.mimeType,
            expiresAt: file.expiresAt,
        };
        saveUpload(deps.cache.file, key, entry, deps.cache.nowMs);
        cache[key] = entry;
        return { uri: file.uri, mimeType: file.mimeType };
    };

    const media: ResolvedMedia[] = [];
    try {
        for (const source of sources) {
            if (source.kind === "invalid")
                throw new Error(`invalid media: ${source.reason}`);
            if (source.kind === "youtube") {
                media.push({
                    kind: "video",
                    uri: source.url,
                    mimeType: undefined,
                });
                continue;
            }
            if (source.kind === "remote") {
                const probe = await probeRemote(source.url, fetchFn);
                if (
                    probe.mimeType &&
                    probe.sizeBytes !== undefined &&
                    probe.sizeBytes <= DIRECT_URL_LIMIT_BYTES
                ) {
                    media.push(toResolved(source.url, probe.mimeType));
                    continue;
                }
                const downloaded = await downloadRemote(source.url, fetchFn);
                cleanups.push(downloaded.cleanup);
                // Not cached: the temporary path is deleted right after this, so a cache entry could never be reused.
                const uploaded = await deps.port.uploadFile(
                    downloaded.path,
                    downloaded.mimeType
                );
                media.push(toResolved(uploaded.uri, uploaded.mimeType));
                continue;
            }
            const mimeType = mimeTypeFor(source.path);
            if (!mimeType)
                throw new Error(`unsupported media type for ${source.path}`);
            const uploaded = await uploadLocal(source.path, mimeType);
            media.push(toResolved(uploaded.uri, uploaded.mimeType));
        }
    } catch (error) {
        await cleanup();
        throw error;
    }
    return { media, cleanup };
}

function toResolved(uri: string, mimeType: string): ResolvedMedia {
    return isAudioMime(mimeType)
        ? { kind: "audio", uri, mimeType }
        : { kind: "video", uri, mimeType };
}
