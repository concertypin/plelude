import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type * as Genai from "@google/genai";
import * as z from "zod";

import type { Resolution, ThinkingLevel } from "@/core/options";

/**
 * How Gemini samples a video: agentic navigation, or static frames with optional clipping.
 * Offsets are duration strings such as "80s"; plain numbers are rejected by the API.
 */
export type VideoProcessing =
    | "agentic"
    | {
          type: "static";
          start_offset?: string;
          end_offset?: string;
          fps?: number;
      };

/**
 * One part of `input` sent to `interactions.create`.
 */
export type InputPart =
    | {
          type: "video";
          uri: string;
          mime_type?: string;
          processing: VideoProcessing;
          /** Tokens per frame: fewer tokens and less detail at "low". Set on the part, not in generation_config. */
          resolution?: Resolution;
      }
    | { type: "audio"; uri: string; mime_type: string }
    | { type: "text"; text: string };

/**
 * Generation settings plelude sets. Other fields the API may return are not carried over.
 */
export interface GenerationConfig {
    thinking_level?: ThinkingLevel;
    max_output_tokens?: number;
}

/**
 * Tools plelude knows how to send.
 */
export type ToolSpec = { type: "google_search" };

/**
 * Parameters for a streaming interaction.
 */
export interface InteractionParams {
    model: string;
    store: boolean;
    input: readonly InputPart[];
    previousInteractionId?: string | undefined;
    systemInstruction?: string | undefined;
    generationConfig?: GenerationConfig | undefined;
    tools?: readonly ToolSpec[] | undefined;
    responseFormat?:
        | {
              type: "text";
              mime_type: "application/json";
              schema: Record<string, unknown>;
          }
        | undefined;
}

/**
 * Events from a streaming interaction, reduced to what plelude uses.
 */
export type StreamEvent =
    | { kind: "created"; id: string }
    | { kind: "text"; text: string }
    | { kind: "completed" }
    | { kind: "error"; message: string; code: string | undefined };

/**
 * The stored state of an interaction, used to continue a conversation.
 */
export interface InteractionView {
    id: string;
    status: string;
    model: string | undefined;
    systemInstruction: string | undefined;
    generationConfig: GenerationConfig | undefined;
    tools: readonly ToolSpec[] | undefined;
}

/**
 * A file Gemini has finished processing and that can be referenced by URI.
 */
export interface UploadedFile {
    name: string;
    uri: string;
    mimeType: string;
    expiresAt: string;
}

/**
 * The narrow set of Gemini operations plelude needs. Tests supply fakes; production uses {@link createGeminiPort}.
 */
export interface GeminiPort {
    streamInteraction(params: InteractionParams): AsyncIterable<StreamEvent>;
    getInteraction(id: string): Promise<InteractionView>;
    uploadFile(filePath: string, mimeType: string): Promise<UploadedFile>;
}

/**
 * Replaces every occurrence of the API key in `text`, so error messages never echo it back.
 */
export function redactKey(text: string, apiKey: string): string {
    return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

const generationConfigSchema = z.object({
    thinking_level: z.enum(["minimal", "low", "medium", "high"]).optional(),
    max_output_tokens: z.number().int().positive().optional(),
});

/**
 * Keeps only the generation settings plelude knows about. Anything else the API returns is dropped
 * instead of being passed back in, so a follow-up never fails on a field plelude cannot validate.
 */
export function readGenerationConfig(
    raw: unknown
): GenerationConfig | undefined {
    const parsed = generationConfigSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const { thinking_level, max_output_tokens } = parsed.data;
    return {
        ...(thinking_level !== undefined ? { thinking_level } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
    };
}

const FILE_POLL_INTERVAL_MS = 1000;
const FILE_POLL_LIMIT = 300;

/**
 * Creates the production {@link GeminiPort} on top of `@google/genai`.
 *
 * The SDK is loaded on first use, not when this module loads. Commands that never call Gemini
 * (`--help`, `config`, `--version`) therefore start without paying for it.
 *
 * @param options.baseUrl - Overrides the API endpoint (from config `baseUrl`).
 */
export function createGeminiPort(options: {
    apiKey: string;
    baseUrl?: string | undefined;
}): GeminiPort {
    let client: Promise<Genai.GoogleGenAI> | undefined;
    const getClient = (): Promise<Genai.GoogleGenAI> => {
        client ??= import("@google/genai").then(
            (sdk) =>
                new sdk.GoogleGenAI(
                    options.baseUrl
                        ? {
                              apiKey: options.apiKey,
                              httpOptions: { baseUrl: options.baseUrl },
                          }
                        : { apiKey: options.apiKey }
                )
        );
        return client;
    };

    return {
        async *streamInteraction(params) {
            const ai = await getClient();
            const stream = await ai.interactions.create({
                model: params.model,
                store: params.store,
                stream: true,
                input: [...params.input],
                ...(params.previousInteractionId
                    ? { previous_interaction_id: params.previousInteractionId }
                    : {}),
                ...(params.systemInstruction
                    ? { system_instruction: params.systemInstruction }
                    : {}),
                ...(params.generationConfig
                    ? { generation_config: { ...params.generationConfig } }
                    : {}),
                ...(params.tools && params.tools.length > 0
                    ? { tools: [...params.tools] }
                    : {}),
                ...(params.responseFormat
                    ? { response_format: params.responseFormat }
                    : {}),
            });
            for await (const event of stream) {
                if (event.event_type === "interaction.created") {
                    yield { kind: "created", id: event.interaction.id };
                } else if (
                    event.event_type === "step.delta" &&
                    event.delta.type === "text"
                ) {
                    yield { kind: "text", text: event.delta.text };
                } else if (event.event_type === "interaction.completed") {
                    yield { kind: "completed" };
                } else if (event.event_type === "error") {
                    yield {
                        kind: "error",
                        message:
                            event.error?.message ?? "unknown error from Gemini",
                        code: event.error?.code,
                    };
                }
            }
        },

        async getInteraction(id) {
            const ai = await getClient();
            const interaction = await ai.interactions.get(id);
            const tools: ToolSpec[] = [];
            for (const tool of interaction.tools ?? []) {
                if (tool.type === "google_search")
                    tools.push({ type: "google_search" });
            }
            return {
                id: interaction.id,
                status: interaction.status,
                model: interaction.model,
                systemInstruction: interaction.system_instruction,
                generationConfig: readGenerationConfig(
                    interaction.generation_config
                ),
                tools: tools.length > 0 ? tools : undefined,
            };
        },

        async uploadFile(filePath, mimeType) {
            const ai = await getClient();
            const { FileState } = await import("@google/genai");
            let file = await ai.files.upload({
                file: filePath,
                config: { mimeType, displayName: path.basename(filePath) },
            });
            for (
                let poll = 0;
                file.state === FileState.PROCESSING && file.name;
                poll += 1
            ) {
                if (poll >= FILE_POLL_LIMIT)
                    throw new Error(
                        `file ${file.name} was still processing after waiting`
                    );
                await sleep(FILE_POLL_INTERVAL_MS);
                file = await ai.files.get({ name: file.name });
            }
            if (file.state === FileState.FAILED) {
                throw new Error(
                    `Gemini failed to process ${path.basename(filePath)}`
                );
            }
            if (!file.name || !file.uri || !file.expirationTime) {
                throw new Error(
                    "the Files API returned an incomplete file record"
                );
            }
            return {
                name: file.name,
                uri: file.uri,
                mimeType: file.mimeType ?? mimeType,
                expiresAt: file.expirationTime,
            };
        },
    };
}
