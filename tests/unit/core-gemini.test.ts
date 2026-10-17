import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
    create: vi.fn<(...args: unknown[]) => unknown>(),
    get: vi.fn<(...args: unknown[]) => unknown>(),
    upload: vi.fn<(...args: unknown[]) => unknown>(),
    fileGet: vi.fn<(...args: unknown[]) => unknown>(),
    constructorOptions: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("@google/genai", () => ({
    FileState: { PROCESSING: "PROCESSING", ACTIVE: "ACTIVE", FAILED: "FAILED" },
    GoogleGenAI: class {
        interactions = { create: mocks.create, get: mocks.get };
        files = { upload: mocks.upload, get: mocks.fileGet };
        constructor(options: unknown) {
            mocks.constructorOptions(options);
        }
    },
}));

vi.mock("node:timers/promises", () => ({
    setTimeout: () => Promise.resolve(),
}));

import {
    createGeminiPort,
    readGenerationConfig,
    redactKey,
} from "@/core/gemini";

async function* streamOf(events: readonly unknown[]): AsyncGenerator<unknown> {
    await Promise.resolve();
    for (const event of events) yield event;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of stream) items.push(item);
    return items;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("redactKey", () => {
    it("replaces every occurrence of the key", () => {
        expect(redactKey("a SECRET b SECRET", "SECRET")).toBe(
            "a [redacted] b [redacted]"
        );
    });

    it("leaves text alone when the key is empty", () => {
        expect(redactKey("unchanged", "")).toBe("unchanged");
    });
});

describe("readGenerationConfig", () => {
    it("keeps only the settings plelude knows", () => {
        expect(
            readGenerationConfig({
                thinking_level: "high",
                max_output_tokens: 128,
                unknown_field: 1,
            })
        ).toEqual({ thinking_level: "high", max_output_tokens: 128 });
    });

    it("returns undefined for a value that does not match", () => {
        expect(
            readGenerationConfig({ thinking_level: "extreme" })
        ).toBeUndefined();
        expect(readGenerationConfig(undefined)).toBeUndefined();
    });
});

describe("createGeminiPort", () => {
    it("creates the SDK client lazily, with the base URL only when one is set", async () => {
        mocks.get.mockResolvedValue({
            id: "v1_x",
            status: "completed",
            tools: undefined,
        });
        const plain = createGeminiPort({ apiKey: "k" });
        expect(mocks.constructorOptions).not.toHaveBeenCalled();
        await plain.getInteraction("v1_x");
        expect(mocks.constructorOptions).toHaveBeenLastCalledWith({
            apiKey: "k",
        });

        const proxied = createGeminiPort({
            apiKey: "k",
            baseUrl: "https://proxy.test",
        });
        await proxied.getInteraction("v1_x");
        expect(mocks.constructorOptions).toHaveBeenLastCalledWith({
            apiKey: "k",
            httpOptions: { baseUrl: "https://proxy.test" },
        });
    });

    it("maps stream events and sends only the fields that are set", async () => {
        mocks.create.mockResolvedValue(
            streamOf([
                {
                    event_type: "interaction.created",
                    interaction: { id: "v1_a" },
                },
                {
                    event_type: "step.delta",
                    delta: { type: "thought_signature" },
                },
                {
                    event_type: "step.delta",
                    delta: { type: "text", text: "hi" },
                },
                { event_type: "interaction.completed" },
                { event_type: "error", error: undefined },
            ])
        );
        const port = createGeminiPort({ apiKey: "k" });
        const events = await collect(
            port.streamInteraction({
                model: "m",
                store: true,
                input: [{ type: "text", text: "q" }],
            })
        );
        expect(events).toEqual([
            { kind: "created", id: "v1_a" },
            { kind: "text", text: "hi" },
            { kind: "completed" },
            {
                kind: "error",
                message: "unknown error from Gemini",
                code: undefined,
            },
        ]);
        expect(mocks.create).toHaveBeenCalledWith({
            model: "m",
            store: true,
            stream: true,
            input: [{ type: "text", text: "q" }],
        });
    });

    it("forwards every optional field when it is set", async () => {
        mocks.create.mockResolvedValue(streamOf([]));
        const port = createGeminiPort({ apiKey: "k" });
        await collect(
            port.streamInteraction({
                model: "m",
                store: false,
                input: [],
                previousInteractionId: "v1_p",
                systemInstruction: "sys",
                generationConfig: { thinking_level: "low" },
                tools: [{ type: "google_search" }],
                responseFormat: {
                    type: "text",
                    mime_type: "application/json",
                    schema: { type: "object" },
                },
            })
        );
        expect(mocks.create).toHaveBeenCalledWith({
            model: "m",
            store: false,
            stream: true,
            input: [],
            previous_interaction_id: "v1_p",
            system_instruction: "sys",
            generation_config: { thinking_level: "low" },
            tools: [{ type: "google_search" }],
            response_format: {
                type: "text",
                mime_type: "application/json",
                schema: { type: "object" },
            },
        });
    });

    it("reads a stored interaction, keeping only google_search tools", async () => {
        mocks.get.mockResolvedValue({
            id: "v1_g",
            status: "completed",
            model: "gemini-3.5-flash-lite",
            system_instruction: "sys",
            generation_config: { thinking_level: "high", extra: true },
            tools: [{ type: "google_search" }, { type: "code_execution" }],
        });
        const view = await createGeminiPort({ apiKey: "k" }).getInteraction(
            "v1_g"
        );
        expect(view).toEqual({
            id: "v1_g",
            status: "completed",
            model: "gemini-3.5-flash-lite",
            systemInstruction: "sys",
            generationConfig: { thinking_level: "high" },
            tools: [{ type: "google_search" }],
        });
    });

    it("waits while a file is processing, then returns it", async () => {
        mocks.upload.mockResolvedValue({
            name: "files/1",
            uri: "https://u/1",
            state: "PROCESSING",
        });
        mocks.fileGet
            .mockResolvedValueOnce({
                name: "files/1",
                uri: "https://u/1",
                state: "PROCESSING",
            })
            .mockResolvedValueOnce({
                name: "files/1",
                uri: "https://u/1",
                state: "ACTIVE",
                mimeType: "video/mp4",
                expirationTime: "2026-10-19T00:00:00Z",
            });
        const file = await createGeminiPort({ apiKey: "k" }).uploadFile(
            "/tmp/a.mp4",
            "video/mp4"
        );
        expect(file).toEqual({
            name: "files/1",
            uri: "https://u/1",
            mimeType: "video/mp4",
            expiresAt: "2026-10-19T00:00:00Z",
        });
        expect(mocks.fileGet).toHaveBeenCalledTimes(2);
    });

    it("fails when Gemini cannot process the file", async () => {
        mocks.upload.mockResolvedValue({
            name: "files/2",
            uri: "https://u/2",
            state: "FAILED",
        });
        await expect(
            createGeminiPort({ apiKey: "k" }).uploadFile(
                "/x/clip.mp4",
                "video/mp4"
            )
        ).rejects.toThrow("failed to process clip.mp4");
    });

    it("gives up when a file stays in PROCESSING too long", async () => {
        mocks.upload.mockResolvedValue({
            name: "files/4",
            uri: "https://u/4",
            state: "PROCESSING",
        });
        mocks.fileGet.mockResolvedValue({
            name: "files/4",
            uri: "https://u/4",
            state: "PROCESSING",
        });
        await expect(
            createGeminiPort({ apiKey: "k" }).uploadFile(
                "/x/slow.mp4",
                "video/mp4"
            )
        ).rejects.toThrow("still processing");
    });

    it("fails on an incomplete file record instead of returning half of it", async () => {
        mocks.upload.mockResolvedValue({
            name: "files/3",
            uri: "https://u/3",
            state: "ACTIVE",
        });
        await expect(
            createGeminiPort({ apiKey: "k" }).uploadFile(
                "/x/clip.mp4",
                "video/mp4"
            )
        ).rejects.toThrow("incomplete file record");
    });
});
