import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    AGENTIC_SYSTEM_INSTRUCTION,
    AnalysisError,
    buildInput,
    buildParams,
    resolveMedia,
    streamAnalysis,
    type AnalysisEvent,
    type ResolvedMedia,
} from "@/core/analyze";
import type {
    GeminiPort,
    InteractionParams,
    InteractionView,
    StreamEvent,
    UploadedFile,
} from "@/core/gemini";
import type { MediaSource } from "@/core/media";
import { type AskPlan, planAsk } from "@/core/options";

const NOW = Date.parse("2026-10-17T00:00:00Z");
const FAR_FUTURE = new Date(NOW + 48 * 3600_000).toISOString();

/** Returns a port whose successive streams follow `attempts`. An attempt that is an Error is thrown instead. */
function scriptedPort(attempts: (StreamEvent[] | Error)[]): {
    port: GeminiPort;
    calls: InteractionParams[];
    uploads: string[];
} {
    const calls: InteractionParams[] = [];
    const uploads: string[] = [];
    let index = 0;
    const port: GeminiPort = {
        streamInteraction(params) {
            calls.push(params);
            const attempt = attempts[index];
            index += 1;
            return (async function* () {
                await Promise.resolve();
                if (attempt === undefined)
                    throw new Error("no scripted attempt left");
                if (attempt instanceof Error) throw attempt;
                for (const event of attempt) yield event;
            })();
        },
        getInteraction(): Promise<InteractionView> {
            return Promise.reject(new Error("not used"));
        },
        uploadFile(filePath: string, mimeType: string): Promise<UploadedFile> {
            uploads.push(filePath);
            return Promise.resolve({
                name: `files/${uploads.length}`,
                uri: `https://generativelanguage.googleapis.com/v1beta/files/${uploads.length}`,
                mimeType,
                expiresAt: FAR_FUTURE,
            });
        },
    };
    return { port, calls, uploads };
}

async function collect(
    stream: AsyncIterable<AnalysisEvent>
): Promise<AnalysisEvent[]> {
    const events: AnalysisEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

const answer = (id: string, text: string): StreamEvent[] => [
    { kind: "created", id },
    { kind: "text", text },
    { kind: "completed" },
];

function plan(overrides: Partial<Parameters<typeof planAsk>[0]> = {}): AskPlan {
    const result = planAsk({
        question: "What happens?",
        media: ["clip.mp4"],
        ...overrides,
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
}

const video: ResolvedMedia = {
    kind: "video",
    uri: "https://example.test/files/1",
    mimeType: "video/mp4",
};

describe("streamAnalysis", () => {
    it("emits the session id first, then text, then done with the id", async () => {
        const { port } = scriptedPort([answer("v1_a", "hello")]);
        const events = await collect(
            streamAnalysis(
                port,
                buildParams(plan(), [video], {
                    defaults: {},
                    inherited: undefined,
                }),
                { apiKey: "k" }
            )
        );
        expect(events).toEqual([
            { type: "session", id: "v1_a" },
            { type: "text", text: "hello" },
            { type: "done", id: "v1_a", text: "hello" },
        ]);
    });

    it("does not announce a session or report an id for ephemeral (unstored) runs", async () => {
        const { port } = scriptedPort([answer("v1_b", "hi")]);
        const params = buildParams(plan({ ephemeral: true }), [video], {
            defaults: {},
            inherited: undefined,
        });
        const events = await collect(
            streamAnalysis(port, params, { apiKey: "k" })
        );
        expect(events.map((event) => event.type)).toEqual(["text", "done"]);
        expect(events.at(-1)).toEqual({
            type: "done",
            id: undefined,
            text: "hi",
        });
    });

    it("retries a transient failure that happened before any text, with a new session", async () => {
        const failed: StreamEvent[] = [
            { kind: "created", id: "v1_first" },
            {
                kind: "error",
                message: "There was a problem processing your request.",
                code: "INTERNAL",
            },
        ];
        const { port, calls } = scriptedPort([
            failed,
            answer("v1_second", "ok"),
        ]);
        const events = await collect(
            streamAnalysis(
                port,
                buildParams(plan(), [video], {
                    defaults: {},
                    inherited: undefined,
                }),
                { apiKey: "k" }
            )
        );
        expect(calls).toHaveLength(2);
        expect(events.filter((event) => event.type === "session")).toEqual([
            { type: "session", id: "v1_first" },
            { type: "session", id: "v1_second" },
        ]);
        expect(
            events.some(
                (event) => event.type === "retry" && event.attempt === 1
            )
        ).toBe(true);
        expect(events.at(-1)).toEqual({
            type: "done",
            id: "v1_second",
            text: "ok",
        });
    });

    it("never retries after text has been printed, because it cannot be taken back", async () => {
        const broken: StreamEvent[] = [
            { kind: "created", id: "v1_x" },
            { kind: "text", text: "partial" },
            { kind: "error", message: "high demand", code: "INTERNAL" },
        ];
        const { port, calls } = scriptedPort([broken]);
        await expect(
            collect(
                streamAnalysis(
                    port,
                    buildParams(plan(), [video], {
                        defaults: {},
                        inherited: undefined,
                    }),
                    { apiKey: "k" }
                )
            )
        ).rejects.toThrow(AnalysisError);
        expect(calls).toHaveLength(1);
    });

    it("does not retry a permanent error such as an unsupported model", async () => {
        const rejected: StreamEvent[] = [
            { kind: "created", id: "v1_y" },
            {
                kind: "error",
                message: "400 model does not support agentic processing",
                code: "invalid_request",
            },
        ];
        const { port, calls } = scriptedPort([rejected]);
        await expect(
            collect(
                streamAnalysis(
                    port,
                    buildParams(plan(), [video], {
                        defaults: {},
                        inherited: undefined,
                    }),
                    { apiKey: "k" }
                )
            )
        ).rejects.toThrow("agentic");
        expect(calls).toHaveLength(1);
    });

    it("retries an empty answer and gives up after the last attempt", async () => {
        const empty: StreamEvent[] = [
            { kind: "created", id: "v1_e" },
            { kind: "completed" },
        ];
        const { port, calls } = scriptedPort([empty, empty, empty]);
        await expect(
            collect(
                streamAnalysis(
                    port,
                    buildParams(plan(), [video], {
                        defaults: {},
                        inherited: undefined,
                    }),
                    { apiKey: "k" }
                )
            )
        ).rejects.toThrow("empty answer");
        expect(calls).toHaveLength(3);
    });

    it("redacts the API key from error messages", async () => {
        const leaky: StreamEvent[] = [
            {
                kind: "error",
                message: "bad key SECRET-123",
                code: "invalid_request",
            },
        ];
        const { port } = scriptedPort([leaky]);
        const params = buildParams(plan(), [video], {
            defaults: {},
            inherited: undefined,
        });
        await expect(
            collect(streamAnalysis(port, params, { apiKey: "SECRET-123" }))
        ).rejects.toThrow("[redacted]");
    });

    it("turns a thrown transport error into an AnalysisError without the key", async () => {
        const { port } = scriptedPort([
            new Error("socket hang up for SECRET-9"),
        ]);
        const params = buildParams(plan(), [video], {
            defaults: {},
            inherited: undefined,
        });
        await expect(
            collect(streamAnalysis(port, params, { apiKey: "SECRET-9" }))
        ).rejects.toThrow("socket hang up for [redacted]");
    });
});

describe("buildInput", () => {
    it("keeps media in order and puts the question last", () => {
        const audio: ResolvedMedia = {
            kind: "audio",
            uri: "https://example.test/a",
            mimeType: "audio/wav",
        };
        const parts = buildInput(plan({ media: ["clip.mp4", "clip.wav"] }), [
            video,
            audio,
        ]);
        expect(parts.map((part) => part.type)).toEqual([
            "video",
            "audio",
            "text",
        ]);
        expect(parts.at(-1)).toEqual({ type: "text", text: "What happens?" });
    });

    it("omits processing for audio and gives agentic videos the agentic mode", () => {
        const audio: ResolvedMedia = {
            kind: "audio",
            uri: "u",
            mimeType: "audio/wav",
        };
        const parts = buildInput(plan(), [video, audio]);
        expect(parts[0]).toMatchObject({
            type: "video",
            processing: "agentic",
            mime_type: "video/mp4",
        });
        expect(parts[1]).not.toHaveProperty("processing");
    });

    it("sends clip settings only in static mode", () => {
        const staticPlan = plan({
            mode: "static",
            start: "01:20",
            end: "03:00",
            fps: 0.5,
        });
        expect(buildInput(staticPlan, [video])[0]).toMatchObject({
            processing: {
                type: "static",
                start_offset: "80s",
                end_offset: "180s",
                fps: 0.5,
            },
        });
    });

    it("omits mime_type for YouTube, which Gemini reads without it", () => {
        const youtube: ResolvedMedia = {
            kind: "video",
            uri: "https://youtu.be/x",
            mimeType: undefined,
        };
        expect(buildInput(plan(), [youtube])[0]).not.toHaveProperty(
            "mime_type"
        );
    });
});

describe("buildParams", () => {
    const defaults = {
        model: undefined,
        thinkingLevel: "low" as const,
        resolution: undefined,
    };

    it("uses the default model when none is set", () => {
        expect(
            buildParams(plan(), [video], { defaults, inherited: undefined })
                .model
        ).toBe("gemini-flash-lite-latest");
    });

    it("prepends the agentic audio instruction to a user system prompt", () => {
        const params = buildParams(
            plan({ system: "Answer in Korean." }),
            [video],
            { defaults, inherited: undefined }
        );
        expect(params.systemInstruction).toBe(
            `${AGENTIC_SYSTEM_INSTRUCTION}\n\nAnswer in Korean.`
        );
    });

    it("does not add the agentic instruction in static mode", () => {
        const params = buildParams(plan({ mode: "static" }), [video], {
            defaults,
            inherited: undefined,
        });
        expect(params.systemInstruction).toBeUndefined();
    });

    it("applies the config default thinking level only to new conversations", () => {
        const fresh = buildParams(plan(), [video], {
            defaults,
            inherited: undefined,
        });
        expect(fresh.generationConfig).toEqual({ thinking_level: "low" });
    });

    it("inherits model, system instruction, generation config and tools on a follow-up", () => {
        const inherited: InteractionView = {
            id: "v1_parent",
            status: "completed",
            model: "gemini-3.5-flash-lite",
            systemInstruction: "previous system",
            generationConfig: { thinking_level: "high" },
            tools: [{ type: "google_search" }],
        };
        const params = buildParams(
            plan({ continueFrom: "v1_parent", media: [] }),
            [],
            {
                defaults,
                inherited,
            }
        );
        expect(params.previousInteractionId).toBe("v1_parent");
        expect(params.model).toBe("gemini-3.5-flash-lite");
        expect(params.systemInstruction).toBe("previous system");
        expect(params.generationConfig).toEqual({ thinking_level: "high" });
        expect(params.tools).toEqual([{ type: "google_search" }]);
    });

    it("lets follow-up flags override inherited settings", () => {
        const inherited: InteractionView = {
            id: "v1_parent",
            status: "completed",
            model: "gemini-3.5-flash-lite",
            systemInstruction: "previous system",
            generationConfig: { thinking_level: "high" },
            tools: undefined,
        };
        const params = buildParams(
            plan({
                continueFrom: "v1_parent",
                media: [],
                thinkingLevel: "minimal",
                system: "new",
            }),
            [],
            { defaults, inherited }
        );
        expect(params.generationConfig).toEqual({ thinking_level: "minimal" });
        expect(params.systemInstruction).toBe(
            `${AGENTIC_SYSTEM_INSTRUCTION}\n\nnew`
        );
    });

    it("enables Google Search grounding with --grounding", () => {
        expect(
            buildParams(plan({ grounding: true }), [video], {
                defaults,
                inherited: undefined,
            }).tools
        ).toEqual([{ type: "google_search" }]);
    });

    it("asks for JSON output when a schema is given", () => {
        const schema = {
            type: "object",
            properties: { x: { type: "string" } },
        };
        const params = buildParams(plan(), [video], {
            defaults,
            inherited: undefined,
            responseSchema: schema,
        });
        expect(params.responseFormat).toEqual({
            type: "text",
            mime_type: "application/json",
            schema,
        });
    });

    it("sends the output token limit when one is given", () => {
        const params = buildParams(plan({ maxTokens: 512 }), [video], {
            defaults,
            inherited: undefined,
        });
        expect(params.generationConfig).toEqual({
            thinking_level: "low",
            max_output_tokens: 512,
        });
    });

    it("stores the session unless ephemeral", () => {
        expect(
            buildParams(plan(), [video], { defaults, inherited: undefined })
                .store
        ).toBe(true);
        expect(
            buildParams(plan({ ephemeral: true }), [video], {
                defaults,
                inherited: undefined,
            }).store
        ).toBe(false);
    });
});

describe("resolveMedia", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "plelude-analyze-"));
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const cache = () => ({
        file: path.join(root, "files.json"),
        fingerprint: "fp",
        nowMs: NOW,
    });

    it("passes a YouTube URL straight through without any upload", async () => {
        const { port, uploads } = scriptedPort([]);
        const sources: MediaSource[] = [
            { kind: "youtube", url: "https://youtu.be/abc" },
        ];
        const { media } = await resolveMedia(sources, { port, cache: cache() });
        expect(media).toEqual([
            { kind: "video", uri: "https://youtu.be/abc", mimeType: undefined },
        ]);
        expect(uploads).toEqual([]);
    });

    it("passes a small remote file by URL, based on the HEAD response", async () => {
        const fetchFn: typeof fetch = (input, init) => {
            expect(init?.method).toBe("HEAD");
            return Promise.resolve(
                new Response(null, {
                    status: 200,
                    headers: {
                        "content-type": "video/mp4",
                        "content-length": "1024",
                    },
                })
            );
        };
        const { port, uploads } = scriptedPort([]);
        const sources: MediaSource[] = [
            { kind: "remote", url: "https://example.test/a.mp4" },
        ];
        const { media } = await resolveMedia(sources, {
            port,
            fetchFn,
            cache: cache(),
        });
        expect(media).toEqual([
            {
                kind: "video",
                uri: "https://example.test/a.mp4",
                mimeType: "video/mp4",
            },
        ]);
        expect(uploads).toEqual([]);
    });

    it("downloads a large remote file and uploads it, then cleans up", async () => {
        const fetchFn: typeof fetch = (_input, init) => {
            if (init?.method === "HEAD") {
                return Promise.resolve(
                    new Response(null, {
                        status: 200,
                        headers: { "content-length": "99999999999" },
                    })
                );
            }
            return Promise.resolve(
                new Response(new Uint8Array([1, 2, 3]), {
                    status: 200,
                    headers: { "content-type": "video/mp4" },
                })
            );
        };
        const { port, uploads } = scriptedPort([]);
        const sources: MediaSource[] = [
            { kind: "remote", url: "https://example.test/big.mp4" },
        ];
        const { media, cleanup } = await resolveMedia(sources, {
            port,
            fetchFn,
            cache: cache(),
        });
        expect(uploads).toHaveLength(1);
        expect(media[0]).toMatchObject({
            kind: "video",
            mimeType: "video/mp4",
        });
        await cleanup();
        expect(uploads[0]).toBeDefined();
    });

    it("uploads a local file and reuses the cached upload on the next run", async () => {
        const file = path.join(root, "clip.mp4");
        writeFileSync(file, "data");
        const { port, uploads } = scriptedPort([]);
        const sources: MediaSource[] = [{ kind: "file", path: file }];
        const first = await resolveMedia(sources, { port, cache: cache() });
        const second = await resolveMedia(sources, { port, cache: cache() });
        expect(uploads).toEqual([file]);
        expect(second.media).toEqual(first.media);
    });

    it("rejects an invalid source and cleans up before rethrowing", async () => {
        const { port } = scriptedPort([]);
        const sources: MediaSource[] = [
            { kind: "invalid", reason: "not a URL" },
        ];
        await expect(
            resolveMedia(sources, { port, cache: cache() })
        ).rejects.toThrow("not a URL");
    });

    it("rejects a local file with an unknown media type", async () => {
        const { port } = scriptedPort([]);
        const sources: MediaSource[] = [
            { kind: "file", path: path.join(root, "notes.txt") },
        ];
        await expect(
            resolveMedia(sources, { port, cache: cache() })
        ).rejects.toThrow("unsupported media type");
    });
});

describe("buildInput resolution", () => {
    it("sets the resolution on each video part, and only on video parts", () => {
        const audio: ResolvedMedia = {
            kind: "audio",
            uri: "https://example.test/a",
            mimeType: "audio/wav",
        };
        const parts = buildInput(plan(), [video, audio], "low");
        expect(parts[0]).toMatchObject({ type: "video", resolution: "low" });
        expect(parts[1]).not.toHaveProperty("resolution");
    });

    it("omits resolution when none is set", () => {
        expect(buildInput(plan(), [video])[0]).not.toHaveProperty("resolution");
    });
});

describe("streamAnalysis with retryEmpty off (--max-tokens set)", () => {
    it("does not retry an empty answer, and explains the token limit", async () => {
        const empty: StreamEvent[] = [
            { kind: "created", id: "v1_m" },
            { kind: "completed" },
        ];
        const { port, calls } = scriptedPort([empty, empty, empty]);
        await expect(
            collect(
                streamAnalysis(
                    port,
                    buildParams(plan({ maxTokens: 10 }), [video], {
                        defaults: {},
                        inherited: undefined,
                    }),
                    {
                        apiKey: "k",
                        retryEmpty: false,
                    }
                )
            )
        ).rejects.toThrow("raise it");
        expect(calls).toHaveLength(1);
    });
});

describe("streamAnalysis stream ends early", () => {
    it("names the cause when the stream stops before completion, instead of reporting an empty answer", async () => {
        const cut: StreamEvent[] = [
            { kind: "created", id: "v1_cut" },
            { kind: "text", text: "The screen is" },
        ];
        const { port } = scriptedPort([cut]);
        await expect(
            collect(
                streamAnalysis(
                    port,
                    buildParams(plan(), [video], {
                        defaults: {},
                        inherited: undefined,
                    }),
                    { apiKey: "k" }
                )
            )
        ).rejects.toThrow("stream ended before");
    });
});
