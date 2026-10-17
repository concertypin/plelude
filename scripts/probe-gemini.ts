/**
 * Manual probe for Gemini API behaviour that plelude depends on but the docs
 * leave unclear. It calls the real API with the key from the plelude config
 * file (or GEMINI_API_KEY) and never prints the key.
 *
 * Usage: node scripts/probe-gemini.ts <step> [...]
 * Steps: model, upload, create, stream, inspect, followup, grounding,
 *        youtube, ephemeral, baseurl
 * State (uploaded file, interaction ids) is kept in .tmp/probe-state.json so
 * later steps can reuse earlier results.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { FileState, GoogleGenAI } from "@google/genai";
import * as z from "zod";

const MODEL = "gemini-flash-lite-latest";
const VIDEO = ".tmp/red-blue.mp4";
const AUDIO = ".tmp/two-beeps.mp3";
const STATE_FILE = ".tmp/probe-state.json";

const stateSchema = z.object({
    videoUri: z.string().optional(),
    videoMime: z.string().optional(),
    audioUri: z.string().optional(),
    audioMime: z.string().optional(),
    interactionId: z.string().optional(),
});
type ProbeState = z.output<typeof stateSchema>;

/** Loads the API key without ever logging it. */
function loadApiKey(): string {
    const fromEnv = process.env["GEMINI_API_KEY"];
    if (fromEnv) return fromEnv;
    const base =
        process.env["XDG_CONFIG_HOME"] ?? path.join(homedir(), ".config");
    const file = path.join(base, "plelude", "config.json");
    const parsed = z
        .object({ apiKey: z.string().min(1) })
        .parse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.apiKey;
}

function loadState(): ProbeState {
    if (!existsSync(STATE_FILE)) return {};
    return stateSchema.parse(JSON.parse(readFileSync(STATE_FILE, "utf8")));
}

function saveState(next: ProbeState): void {
    // Mutate the shared object so later steps in the same run see the update.
    Object.assign(state, next);
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Prints a value as JSON, truncated so huge responses stay readable. */
function dump(label: string, value: unknown, limit = 4000): void {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    console.log(`\n=== ${label}`);
    console.log(
        text.length > limit
            ? `${text.slice(0, limit)}\n…(${text.length} chars)`
            : text
    );
}

const apiKey = loadApiKey();
const ai = new GoogleGenAI({ apiKey });
const state = loadState();

async function uploadActive(file: string, mimeType: string) {
    let uploaded = await ai.files.upload({ file, config: { mimeType } });
    while (uploaded.state === FileState.PROCESSING && uploaded.name) {
        await sleep(1000);
        uploaded = await ai.files.get({ name: uploaded.name });
    }
    return uploaded;
}

/** Polls until the interaction leaves in_progress, then returns a compact view. */
async function waitDone(id: string) {
    let current = await ai.interactions.get(id);
    while (current.status === "in_progress") {
        await sleep(2000);
        current = await ai.interactions.get(id);
    }
    return {
        status: current.status,
        model: current.model,
        output_text: current.output_text,
        errors: current.errors,
        usage: current.usage,
        stepTypes: current.steps?.map((step) => step.type),
    };
}

function requireValue(value: string | undefined, hint: string): string {
    if (!value) throw new Error(`missing state: run the "${hint}" step first`);
    return value;
}

const steps: Record<string, () => Promise<void>> = {
    async model() {
        const info = await ai.models.get({ model: MODEL });
        dump("models.get(gemini-flash-lite-latest)", info);
    },

    async upload() {
        const video = await uploadActive(VIDEO, "video/mp4");
        dump("video file", video);
        const audio = await uploadActive(AUDIO, "audio/mpeg");
        dump("audio file", audio);
        saveState({
            ...state,
            videoUri: video.uri,
            videoMime: video.mimeType,
            audioUri: audio.uri,
            audioMime: audio.mimeType,
        });
    },

    async create() {
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            system_instruction: "Answer in one short English sentence.",
            generation_config: { thinking_level: "low" },
            input: [
                {
                    type: "video",
                    uri: requireValue(state.videoUri, "upload"),
                    mime_type: requireValue(state.videoMime, "upload"),
                    processing: "agentic",
                },
                {
                    type: "text",
                    text: "Which colors fill the screen, and at what timestamps does it change?",
                },
            ],
        });
        dump("interactions.create (background)", interaction);
        saveState({ ...state, interactionId: interaction.id });
    },

    async stream() {
        const id = requireValue(state.interactionId, "create");
        let lastEventId: string | undefined;
        let count = 0;
        const first = await ai.interactions.get(id, { stream: true });
        for await (const event of first) {
            count += 1;
            if (event.event_id) lastEventId = event.event_id;
            dump(`event #${count}`, event, 800);
            if (count >= 3) break;
        }
        console.log(`\n--- resuming after event_id=${lastEventId ?? "(none)"}`);
        const resumed = await ai.interactions.get(id, {
            stream: true,
            ...(lastEventId ? { last_event_id: lastEventId } : {}),
        });
        for await (const event of resumed) {
            count += 1;
            dump(`resumed event #${count}`, event, 800);
        }
    },

    async inspect() {
        const id = requireValue(state.interactionId, "create");
        const interaction = await ai.interactions.get(id);
        dump("interactions.get (non-stream, full)", interaction, 12000);
    },

    async followup() {
        const id = requireValue(state.interactionId, "create");
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            previous_interaction_id: id,
            input: [
                {
                    type: "audio",
                    uri: requireValue(state.audioUri, "upload"),
                    mime_type: requireValue(state.audioMime, "upload"),
                },
                {
                    type: "text",
                    text: "New file attached: how many beeps does this audio contain, and is the second higher or lower? Also, what was the first color in the earlier video?",
                },
            ],
        });
        let current = interaction;
        while (current.status === "in_progress") {
            await sleep(2000);
            current = await ai.interactions.get(current.id);
        }
        dump("follow-up with new audio (final)", current, 8000);
    },

    async audio() {
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            input: [
                {
                    type: "audio",
                    uri: requireValue(state.audioUri, "upload"),
                    mime_type: requireValue(state.audioMime, "upload"),
                },
                {
                    type: "text",
                    text: "How many beeps does this audio contain, and is the second higher or lower in pitch?",
                },
            ],
        });
        dump("fresh audio-only (final)", await waitDone(interaction.id), 4000);
    },

    async "followup-video"() {
        const id = requireValue(state.interactionId, "create");
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            previous_interaction_id: id,
            input: [
                {
                    type: "video",
                    uri: requireValue(state.videoUri, "upload"),
                    mime_type: requireValue(state.videoMime, "upload"),
                    processing: "agentic",
                },
                {
                    type: "text",
                    text: "I attached the video again as a new file. Is it the same as the earlier one? Answer yes or no and why.",
                },
            ],
        });
        dump(
            "follow-up with new video (final)",
            await waitDone(interaction.id),
            4000
        );
    },

    async "followup-text"() {
        const id = requireValue(state.interactionId, "create");
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            previous_interaction_id: id,
            input: "What was the second color?",
        });
        dump(
            "follow-up text only (final)",
            await waitDone(interaction.id),
            4000
        );
    },

    async grounding() {
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            tools: [{ type: "google_search" }],
            input: [
                {
                    type: "video",
                    uri: requireValue(state.videoUri, "upload"),
                    mime_type: requireValue(state.videoMime, "upload"),
                    processing: "agentic",
                },
                {
                    type: "text",
                    text: "What is the first color in this video? Then search the web: what is the hex code of that color in the CSS named colors list?",
                },
            ],
        });
        let current = interaction;
        while (current.status === "in_progress") {
            await sleep(2000);
            current = await ai.interactions.get(current.id);
        }
        dump("agentic video + google_search (final)", current, 12000);
    },

    async youtube() {
        const interaction = await ai.interactions.create({
            model: MODEL,
            background: true,
            input: [
                {
                    type: "video",
                    uri: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
                    processing: "agentic",
                },
                {
                    type: "text",
                    text: "In one sentence, what animal is shown?",
                },
            ],
        });
        let current = interaction;
        while (current.status === "in_progress") {
            await sleep(2000);
            current = await ai.interactions.get(current.id);
        }
        dump("youtube + agentic (final)", current, 6000);
    },

    async ephemeral() {
        const stream = await ai.interactions.create({
            model: MODEL,
            store: false,
            stream: true,
            input: [
                {
                    type: "video",
                    uri: requireValue(state.videoUri, "upload"),
                    mime_type: requireValue(state.videoMime, "upload"),
                    processing: "agentic",
                },
                { type: "text", text: "Describe this video in one sentence." },
            ],
        });
        let count = 0;
        for await (const event of stream) {
            count += 1;
            dump(`ephemeral event #${count}`, event, 600);
        }
    },

    async baseurl() {
        const broken = new GoogleGenAI({
            apiKey,
            httpOptions: { baseUrl: "http://127.0.0.1:9" },
        });
        for (const [label, call] of [
            ["models.get", () => broken.models.get({ model: MODEL })],
            [
                "interactions.create",
                () => broken.interactions.create({ model: MODEL, input: "hi" }),
            ],
        ] as const) {
            try {
                await call();
                console.log(`${label}: succeeded (baseUrl was IGNORED)`);
            } catch (error) {
                console.log(
                    `${label}: failed as expected -> ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
                );
            }
        }
    },
};

for (const name of process.argv.slice(2)) {
    const step = steps[name];
    if (!step) {
        console.error(
            `unknown step "${name}". steps: ${Object.keys(steps).join(", ")}`
        );
        process.exitCode = 2;
        break;
    }
    try {
        await step();
    } catch (error) {
        dump(
            `step "${name}" threw`,
            error instanceof Error ? { message: error.message } : error
        );
        process.exitCode = 1;
    }
}
