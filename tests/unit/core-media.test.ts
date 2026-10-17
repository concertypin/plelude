import path from "node:path";

import { describe, expect, it } from "vitest";

import { classifyMedia, isAudioMime, mimeTypeFor } from "@/core/media";

describe("classifyMedia", () => {
    it.concurrent.each([
        "https://www.youtube.com/watch?v=abc",
        "https://youtu.be/abc",
        "https://M.YouTube.com/watch?v=abc",
    ])("treats %s as YouTube", (url) => {
        expect(classifyMedia(url)).toEqual({ kind: "youtube", url });
    });

    it("treats other http(s) URLs as remote", () => {
        expect(classifyMedia("https://example.com/a.mp4")).toEqual({
            kind: "remote",
            url: "https://example.com/a.mp4",
        });
    });

    it("resolves anything else as a local file path", () => {
        expect(classifyMedia("  videos/a.mp4 ")).toEqual({
            kind: "file",
            path: path.resolve("videos/a.mp4"),
        });
    });

    it("marks a malformed URL as invalid instead of throwing", () => {
        expect(classifyMedia("https://")).toMatchObject({ kind: "invalid" });
    });
});

describe("mimeTypeFor", () => {
    it.concurrent.each([
        ["a.mp4", "video/mp4"],
        ["A.MP4", "video/mp4"],
        ["b.mp3", "audio/mpeg"],
        ["c.wav", "audio/wav"],
    ])("maps %s to %s", (file, mime) => {
        expect(mimeTypeFor(file)).toBe(mime);
    });

    it("returns undefined for an unknown extension", () => {
        expect(mimeTypeFor("notes.txt")).toBeUndefined();
    });

    it("lets an explicit override win over the extension", () => {
        expect(mimeTypeFor("notes.txt", "video/mp4")).toBe("video/mp4");
    });
});

describe("isAudioMime", () => {
    it("is true only for audio types", () => {
        expect(isAudioMime("audio/wav")).toBe(true);
        expect(isAudioMime("video/mp4")).toBe(false);
    });
});
