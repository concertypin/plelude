import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { downloadRemote, pickRemoteMime, probeRemote } from "@/core/remote";

describe("pickRemoteMime", () => {
    it("prefers an audio or video content type from the server", () => {
        expect(
            pickRemoteMime("https://x.test/file", "video/webm; codecs=vp9")
        ).toBe("video/webm");
    });

    it("falls back to the URL extension for other content types", () => {
        expect(
            pickRemoteMime(
                "https://x.test/clip.mp4?token=1",
                "application/octet-stream"
            )
        ).toBe("video/mp4");
    });

    it("returns undefined when neither source tells the type", () => {
        expect(pickRemoteMime("https://x.test/file", null)).toBeUndefined();
    });
});

describe("probeRemote", () => {
    it("reads the type and the size", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(
                new Response(null, {
                    headers: {
                        "content-type": "audio/wav",
                        "content-length": "42",
                    },
                })
            );
        await expect(
            probeRemote("https://x.test/a.wav", fetchFn)
        ).resolves.toEqual({
            mimeType: "audio/wav",
            sizeBytes: 42,
        });
    });

    it("does not trust Content-Length when the body is encoded", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(
                new Response(null, {
                    headers: {
                        "content-type": "video/mp4",
                        "content-length": "42",
                        "content-encoding": "gzip",
                    },
                })
            );
        const probe = await probeRemote("https://x.test/a.mp4", fetchFn);
        expect(probe.sizeBytes).toBeUndefined();
    });

    it("reports nothing when the server refuses HEAD", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(new Response(null, { status: 405 }));
        await expect(
            probeRemote("https://x.test/a.mp4", fetchFn)
        ).resolves.toEqual({
            mimeType: undefined,
            sizeBytes: undefined,
        });
    });
});

describe("downloadRemote", () => {
    it("writes the decoded body to a temporary file and cleans up on request", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(
                new Response(new Uint8Array(200_000).fill(7), {
                    headers: { "content-type": "video/mp4" },
                })
            );
        const downloaded = await downloadRemote(
            "https://x.test/big.mp4",
            fetchFn
        );
        expect(downloaded.mimeType).toBe("video/mp4");
        expect(downloaded.path.endsWith(".mp4")).toBe(true);
        expect(existsSync(downloaded.path)).toBe(true);
        await downloaded.cleanup();
        expect(existsSync(downloaded.path)).toBe(false);
    });

    it("fails with the HTTP status when the download is refused", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(new Response(null, { status: 403 }));
        await expect(
            downloadRemote("https://x.test/a.mp4", fetchFn)
        ).rejects.toThrow("HTTP 403");
    });

    it("fails when the media type cannot be determined", async () => {
        const fetchFn: typeof fetch = () =>
            Promise.resolve(new Response("data"));
        await expect(
            downloadRemote("https://x.test/blob", fetchFn)
        ).rejects.toThrow("cannot tell the media type");
    });

    it("removes the temporary directory when the body stream breaks mid-way", async () => {
        const broken = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.error(new Error("connection reset"));
            },
        });
        const fetchFn: typeof fetch = () =>
            Promise.resolve(
                new Response(broken, {
                    headers: { "content-type": "video/mp4" },
                })
            );
        await expect(
            downloadRemote("https://x.test/x.mp4", fetchFn)
        ).rejects.toThrow("connection reset");
    });
});
