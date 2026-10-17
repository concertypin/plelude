import path from "node:path";

import { describe, expect, it } from "vitest";

import { type AskInput, parseTimestamp, planAsk } from "@/core/options";

const base: AskInput = { question: "What happens?", media: ["clip.mp4"] };

describe("parseTimestamp", () => {
    it.concurrent.each([
        ["90", 90],
        ["90.5", 90.5],
        ["01:30", 90],
        ["1:02:03", 3723],
        ["0", 0],
    ])("parses %s as %d seconds", (input, seconds) => {
        expect(parseTimestamp(input)).toBe(seconds);
    });

    it.concurrent.each(["", "abc", "1:2:3:4", "-5", "1:-2", "1.2.3", ":30"])(
        "rejects %j",
        (input) => {
            expect(parseTimestamp(input)).toBeUndefined();
        }
    );
});

describe("planAsk", () => {
    it("builds an agentic plan with defaults for a single file", () => {
        const result = planAsk(base);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.mode).toBe("agentic");
        expect(result.value.ephemeral).toBe(false);
        expect(result.value.grounding).toBe(false);
        expect(result.value.sources).toEqual([
            { kind: "file", path: path.resolve("clip.mp4") },
        ]);
    });

    it("trims the question and rejects an empty one", () => {
        expect(planAsk({ ...base, question: "   " })).toMatchObject({
            ok: false,
        });
        expect(planAsk({ ...base, question: undefined })).toMatchObject({
            ok: false,
        });
        const trimmed = planAsk({ ...base, question: "  hi  " });
        expect(trimmed.ok && trimmed.value.question).toBe("hi");
    });

    it("requires media unless continuing a session", () => {
        expect(planAsk({ ...base, media: [] })).toMatchObject({ ok: false });
        expect(
            planAsk({ question: "more?", media: [], continueFrom: "v1_abc" })
        ).toMatchObject({ ok: true });
    });

    it("allows new media on a follow-up", () => {
        const result = planAsk({
            question: "and this?",
            media: ["other.mp3"],
            continueFrom: "v1_abc",
        });
        expect(result.ok && result.value.continueFrom).toBe("v1_abc");
        expect(result.ok && result.value.sources).toHaveLength(1);
    });

    it("rejects --ephemeral together with -c, because ephemeral sessions are not stored", () => {
        const result = planAsk({
            ...base,
            continueFrom: "v1_abc",
            ephemeral: true,
        });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toContain("--ephemeral");
    });

    it("rejects clip flags unless --mode static is given", () => {
        expect(planAsk({ ...base, start: "01:00" })).toMatchObject({
            ok: false,
        });
        expect(planAsk({ ...base, end: "02:00" })).toMatchObject({ ok: false });
        expect(planAsk({ ...base, fps: 0.5 })).toMatchObject({ ok: false });
        expect(planAsk({ ...base, mode: "agentic", fps: 0.5 })).toMatchObject({
            ok: false,
        });
    });

    it("accepts clip flags with --mode static and converts them to seconds", () => {
        const result = planAsk({
            ...base,
            mode: "static",
            start: "01:20",
            end: "03:00",
            fps: 0.5,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.mode).toBe("static");
        expect(result.value.clip).toEqual({
            startSec: 80,
            endSec: 180,
            fps: 0.5,
        });
    });

    it("rejects an unknown mode", () => {
        expect(planAsk({ ...base, mode: "turbo" })).toMatchObject({
            ok: false,
        });
    });

    it("rejects a start that is not before the end", () => {
        expect(
            planAsk({ ...base, mode: "static", start: "60", end: "60" })
        ).toMatchObject({ ok: false });
        expect(
            planAsk({ ...base, mode: "static", start: "90", end: "60" })
        ).toMatchObject({ ok: false });
    });

    it("rejects an unparseable timestamp with the flag name in the message", () => {
        const result = planAsk({ ...base, mode: "static", start: "soon" });
        expect(!result.ok && result.error).toContain("--start");
    });

    it("rejects non-positive fps and non-integer max tokens", () => {
        expect(planAsk({ ...base, mode: "static", fps: 0 })).toMatchObject({
            ok: false,
        });
        expect(planAsk({ ...base, maxTokens: 1.5 })).toMatchObject({
            ok: false,
        });
        expect(planAsk({ ...base, maxTokens: 0 })).toMatchObject({ ok: false });
        expect(planAsk({ ...base, maxTokens: 512 })).toMatchObject({
            ok: true,
        });
    });

    it("validates thinking level and resolution against their allowed values", () => {
        expect(planAsk({ ...base, thinkingLevel: "low" })).toMatchObject({
            ok: true,
        });
        expect(planAsk({ ...base, thinkingLevel: "extreme" })).toMatchObject({
            ok: false,
        });
        expect(planAsk({ ...base, resolution: "high" })).toMatchObject({
            ok: true,
        });
        expect(planAsk({ ...base, resolution: "ultra" })).toMatchObject({
            ok: false,
        });
    });

    it("reports an invalid media entry with its raw text", () => {
        const result = planAsk({ ...base, media: ["https://"] });
        expect(!result.ok && result.error).toContain("https://");
    });
});

describe("planAsk clip validation", () => {
    it("rejects an unparseable --end with the flag name in the message", () => {
        const result = planAsk({ ...base, mode: "static", end: "later" });
        expect(!result.ok && result.error).toContain("--end");
    });
});
