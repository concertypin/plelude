import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { runAsk } from "@/cli/ask";
import { maskSecret, runConfig } from "@/cli/config-command";
import { ASK_HELP, MAIN_HELP } from "@/cli/help";
import { main } from "@/cli/main";
import { EXIT, type CliDeps } from "@/cli/shared";
import { runUpload } from "@/cli/upload";
import { VERSION } from "@/cli/version";
import type {
    GeminiPort,
    InteractionParams,
    InteractionView,
    StreamEvent,
    UploadedFile,
} from "@/core/gemini";

const NOW = Date.parse("2026-10-17T00:00:00Z");
const FAR = new Date(NOW + 48 * 3600_000).toISOString();

interface Fake {
    port: GeminiPort;
    calls: InteractionParams[];
}

/**
 * A fake Gemini port. Every analysis streams `events`. `inherited` is returned for follow-up lookups.
 */
function fakePort(events: StreamEvent[], inherited?: InteractionView): Fake {
    const calls: InteractionParams[] = [];
    const port: GeminiPort = {
        streamInteraction(params) {
            calls.push(params);
            return (async function* () {
                await Promise.resolve();
                for (const event of events) yield event;
            })();
        },
        getInteraction(id) {
            if (inherited && id === inherited.id)
                return Promise.resolve(inherited);
            return Promise.reject(new Error(`no such session ${id}`));
        },
        uploadFile(filePath, mimeType): Promise<UploadedFile> {
            return Promise.resolve({
                name: "files/1",
                uri: `https://files.test/${path.basename(filePath)}`,
                mimeType,
                expiresAt: FAR,
            });
        },
    };
    return { port, calls };
}

const answer = (id: string, text: string): StreamEvent[] => [
    { kind: "created", id },
    { kind: "text", text },
    { kind: "completed" },
];

interface Harness {
    deps: CliDeps;
    output: () => string;
}

function harness(
    env: NodeJS.ProcessEnv,
    options: { stdin?: string; fake?: Fake } = {}
): Harness {
    const chunks: string[] = [];
    const deps: CliDeps = {
        write: (text) => {
            chunks.push(text);
        },
        readStdin: () => Promise.resolve(options.stdin ?? ""),
        isTTY: false,
        readSecret: () => Promise.resolve(""),
        env,
        now: () => NOW,
        createPort: () => {
            if (!options.fake)
                throw new Error("no port configured for this test");
            return options.fake.port;
        },
    };
    return { deps, output: () => chunks.join("") };
}

let root: string;
let env: NodeJS.ProcessEnv;
let clip: string;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "plelude-cli-"));
    env = { XDG_CONFIG_HOME: root, GEMINI_API_KEY: "test-key-123" };
    clip = path.join(root, "clip.mp4");
    writeFileSync(clip, "fake-video-bytes");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("main", () => {
    it("prints the main help with a usage exit code when no command is given", async () => {
        const h = harness(env);
        expect(await main([], h.deps)).toBe(EXIT.usage);
        expect(h.output()).toBe(MAIN_HELP);
    });

    it("prints the version, which matches package.json", async () => {
        const h = harness(env);
        expect(await main(["--version"], h.deps)).toBe(EXIT.ok);
        const pkg = z
            .object({ version: z.string() })
            .parse(
                JSON.parse(readFileSync(path.resolve("package.json"), "utf8"))
            );
        expect(h.output().trim()).toBe(VERSION);
        expect(VERSION).toBe(pkg.version);
    });

    it("rejects an unknown command with a usage exit code", async () => {
        const h = harness(env);
        expect(await main(["bogus"], h.deps)).toBe(EXIT.usage);
        expect(h.output()).toContain('unknown command "bogus"');
    });
});

describe("plelude ask: usage errors (exit 2)", () => {
    it.each([
        [["-m", "clip.mp4"], "a question is required"],
        [["one", "two", "-m", "clip.mp4"], "expected one question"],
        [["q"], "at least one -m/--media"],
        [
            ["q", "-m", "clip.mp4", "--ephemeral", "-c", "v1_x"],
            "--ephemeral cannot be combined",
        ],
        [
            ["q", "-m", "clip.mp4", "--start", "10"],
            "only apply with --mode static",
        ],
        [
            [
                "q",
                "-m",
                "clip.mp4",
                "--mode",
                "static",
                "--start",
                "50",
                "--end",
                "10",
            ],
            "--start must be earlier",
        ],
        [["q", "-m", "clip.mp4", "--fps", "fast"], "--fps must be a number"],
        [
            ["q", "-m", "clip.mp4", "--thinking-level", "extreme"],
            "invalid --thinking-level",
        ],
        [["q", "-m", "/definitely/missing.mp4"], "media file not found"],
        [["q", "--bogus-flag"], "Unknown option"],
    ])("rejects %j", async (args, message) => {
        const h = harness(env, { fake: fakePort([]) });
        const code = await runAsk(args, h.deps);
        expect(code).toBe(EXIT.usage);
        expect(h.output()).toContain(message);
        expect(h.output().startsWith("[plelude] error:")).toBe(true);
    });

    it("prints help for --help without contacting Gemini", async () => {
        const h = harness(env);
        expect(await runAsk(["--help"], h.deps)).toBe(EXIT.ok);
        expect(h.output()).toBe(ASK_HELP);
    });
});

describe("plelude ask: missing key (exit 3)", () => {
    it("explains how to set the key", async () => {
        const h = harness({ XDG_CONFIG_HOME: root });
        expect(await runAsk(["q", "-m", clip], h.deps)).toBe(EXIT.noKey);
        expect(h.output()).toContain("no Gemini API key");
        expect(h.output()).toContain("GEMINI_API_KEY");
    });
});

describe("plelude ask: streamed output", () => {
    it("reads the question from stdin when given -", async () => {
        const fake = fakePort(answer("v1_stdin", "done"));
        const h = harness(env, { stdin: "  from stdin  \n", fake });
        expect(await runAsk(["-", "-m", clip], h.deps)).toBe(EXIT.ok);
        expect(fake.calls[0]?.input.at(-1)).toEqual({
            type: "text",
            text: "from stdin",
        });
    });

    it("prints the session first, then the answer, then a done line with the follow-up command", async () => {
        const fake = fakePort(answer("v1_out", "Red, then blue."));
        const h = harness(env, { fake });
        expect(await runAsk(["What colors appear?", "-m", clip], h.deps)).toBe(
            EXIT.ok
        );
        expect(h.output()).toBe(
            [
                "[plelude] session=v1_out",
                "Red, then blue.",
                '[plelude] done session=v1_out  follow-up: plelude ask -c v1_out "<question>"',
                "",
            ].join("\n")
        );
    });

    it("prints a single JSON object with --json, and never prints the key", async () => {
        const fake = fakePort(answer("v1_json", "answer"));
        const h = harness(env, { fake });
        expect(await runAsk(["q", "-m", clip, "--json"], h.deps)).toBe(EXIT.ok);
        const lines = h.output().trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] ?? "")).toEqual({
            session: "v1_json",
            text: "answer",
            error: null,
        });
        expect(h.output()).not.toContain("test-key-123");
    });

    it("says so for --ephemeral and sends store: false", async () => {
        const fake = fakePort(answer("v1_e", "private"));
        const h = harness(env, { fake });
        expect(await runAsk(["q", "-m", clip, "--ephemeral"], h.deps)).toBe(
            EXIT.ok
        );
        expect(fake.calls[0]?.store).toBe(false);
        expect(h.output()).toContain("[plelude] done (ephemeral, not stored)");
        expect(h.output()).not.toContain("session=");
    });

    it("reports a Gemini failure on stdout with exit 1, and never prints the key", async () => {
        const fake = fakePort([
            {
                kind: "error",
                message: "bad request for test-key-123",
                code: "invalid_request",
            },
        ]);
        const h = harness(env, { fake });
        expect(await runAsk(["q", "-m", clip], h.deps)).toBe(EXIT.gemini);
        expect(h.output()).toContain(
            "[plelude] error: bad request for [redacted]"
        );
        expect(h.output()).not.toContain("test-key-123");
    });

    it("uses agentic processing with the audio guidance by default", async () => {
        const fake = fakePort(answer("v1_a", "ok"));
        const h = harness(env, { fake });
        await runAsk(["q", "-m", clip], h.deps);
        expect(fake.calls[0]?.systemInstruction).toContain(
            "include_audio: true"
        );
        expect(fake.calls[0]?.input[0]).toMatchObject({
            type: "video",
            processing: "agentic",
        });
    });
});

describe("plelude ask -c: follow-ups", () => {
    it("inherits the parent model, system instruction, and tools", async () => {
        const inherited: InteractionView = {
            id: "v1_parent",
            status: "completed",
            model: "gemini-3.5-flash-lite",
            systemInstruction: "earlier",
            generationConfig: { thinking_level: "high" },
            tools: [{ type: "google_search" }],
        };
        const fake = fakePort(answer("v1_child", "next"), inherited);
        const h = harness(env, { fake });
        expect(await runAsk(["-c", "v1_parent", "and then?"], h.deps)).toBe(
            EXIT.ok
        );
        expect(fake.calls[0]).toMatchObject({
            model: "gemini-3.5-flash-lite",
            previousInteractionId: "v1_parent",
            systemInstruction: "earlier",
            tools: [{ type: "google_search" }],
        });
    });

    it("reports an unknown session as an error with exit 1", async () => {
        const fake = fakePort(answer("v1_x", "unused"));
        const h = harness(env, { fake });
        expect(await runAsk(["-c", "v1_missing", "q"], h.deps)).toBe(
            EXIT.gemini
        );
        expect(h.output()).toContain("no such session v1_missing");
    });
});

describe("plelude upload", () => {
    it("prints the URI for a local file", async () => {
        const h = harness(env, { fake: fakePort([]) });
        expect(await runUpload([clip], h.deps)).toBe(EXIT.ok);
        expect(h.output()).toBe(
            "[plelude] uri=https://files.test/clip.mp4 mime=video/mp4\n"
        );
    });

    it("rejects a missing file and a missing argument", async () => {
        const h = harness(env, { fake: fakePort([]) });
        expect(await runUpload(["/nope/x.mp4"], h.deps)).toBe(EXIT.usage);
        expect(await runUpload([], h.deps)).toBe(EXIT.usage);
    });
});

describe("plelude config", () => {
    it("stores a value and reads it back", async () => {
        const h = harness(env);
        expect(
            await runConfig(["set", "model", "gemini-3.8-flash"], h.deps)
        ).toBe(EXIT.ok);
        expect(await runConfig(["get", "model"], h.deps)).toBe(EXIT.ok);
        expect(h.output()).toContain("[plelude] saved model");
        expect(h.output()).toContain("gemini-3.8-flash\n");
    });

    it("refuses an API key given as an argument, so it cannot end up in shell history", async () => {
        const h = harness(env);
        expect(
            await runConfig(["set", "apiKey", "AIza-secret-value"], h.deps)
        ).toBe(EXIT.usage);
        expect(h.output()).toContain("never accepted as an argument");
    });

    it("reads an API key from stdin and shows it masked", async () => {
        const fresh = { XDG_CONFIG_HOME: root };
        const h = harness(fresh, { stdin: "AIzaSyD-example-key-1234\n" });
        expect(await runConfig(["set", "apiKey"], h.deps)).toBe(EXIT.ok);
        const shown = harness(fresh);
        expect(await runConfig(["get", "apiKey"], shown.deps)).toBe(EXIT.ok);
        expect(shown.output()).toBe(
            `${maskSecret("AIzaSyD-example-key-1234")}\n`
        );
        expect(shown.output()).not.toContain("example-key");
    });

    it("rejects an invalid value with a usage error", async () => {
        const h = harness(env);
        expect(
            await runConfig(["set", "thinkingLevel", "extreme"], h.deps)
        ).toBe(EXIT.usage);
        expect(h.output()).toContain("invalid thinkingLevel");
    });

    it("removes a value with unset", async () => {
        const h = harness(env);
        await runConfig(["set", "model", "m1"], h.deps);
        expect(await runConfig(["unset", "model"], h.deps)).toBe(EXIT.ok);
        const after = harness(env);
        await runConfig(["get", "model"], after.deps);
        expect(after.output()).toContain("not set");
    });

    it("prints the config path", async () => {
        const h = harness(env);
        expect(await runConfig(["path"], h.deps)).toBe(EXIT.ok);
        expect(h.output().trim()).toBe(
            path.join(root, "plelude", "config.json")
        );
    });
});

describe("error reporting contract", () => {
    it("writes an unreadable config file error to stdout with exit 1", async () => {
        mkdirSync(path.join(root, "plelude"), { recursive: true });
        writeFileSync(path.join(root, "plelude", "config.json"), "{ broken");
        const h = harness({ XDG_CONFIG_HOME: root });
        expect(await main(["ask", "q", "-m", clip], h.deps)).toBe(EXIT.gemini);
        expect(h.output().startsWith("[plelude] error:")).toBe(true);
    });

    it("redacts the API key from errors raised before streaming starts", async () => {
        const h = harness(env, { fake: fakePort([]) });
        // The session id is the key itself, so the fake's "no such session" error contains the key.
        expect(await runAsk(["-c", "test-key-123", "q"], h.deps)).toBe(
            EXIT.gemini
        );
        expect(h.output()).toContain("[redacted]");
        expect(h.output()).not.toContain("test-key-123");
    });
});
