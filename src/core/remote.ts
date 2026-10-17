import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isAudioMime, mimeTypeFor } from "@/core/media";

/** Largest remote file Gemini fetches itself when given a plain URI. Bigger files are downloaded first. */
export const DIRECT_URL_LIMIT_BYTES = 15 * 1024 * 1024;

export interface RemoteProbe {
    mimeType: string | undefined;
    /** Size from `Content-Length`, when the server sent it without content encoding. */
    sizeBytes: number | undefined;
}

/**
 * Picks the MIME type of a remote file: the server's audio/video content type if it has one,
 * otherwise the URL's file extension.
 */
export function pickRemoteMime(
    url: string,
    contentType: string | null
): string | undefined {
    const declared = contentType?.split(";")[0]?.trim().toLowerCase();
    if (declared && (declared.startsWith("video/") || isAudioMime(declared)))
        return declared;
    return mimeTypeFor(new URL(url).pathname);
}

/**
 * Sends a HEAD request to learn the MIME type and size of a remote file.
 * A server that refuses HEAD yields no information, which sends the caller down the download path.
 */
export async function probeRemote(
    url: string,
    fetchFn: typeof fetch = fetch
): Promise<RemoteProbe> {
    const response = await fetchFn(url, { method: "HEAD", redirect: "follow" });
    if (!response.ok) return { mimeType: undefined, sizeBytes: undefined };
    const length = response.headers.get("content-length");
    const encoded = response.headers.get("content-encoding");
    return {
        mimeType: pickRemoteMime(url, response.headers.get("content-type")),
        sizeBytes:
            length !== null && (encoded === null || encoded === "identity")
                ? Number(length)
                : undefined,
    };
}

/**
 * Downloads a remote file into a fresh temporary directory. The bytes written are the decoded body,
 * so the uploaded size always matches the file on disk, whatever `Content-Encoding` the server used.
 *
 * @returns The local path, its MIME type, and a `cleanup` that removes the directory.
 */
export async function downloadRemote(
    url: string,
    fetchFn: typeof fetch = fetch
): Promise<{ path: string; mimeType: string; cleanup: () => Promise<void> }> {
    const response = await fetchFn(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
        throw new Error(`could not download ${url} (HTTP ${response.status})`);
    }
    const mimeType = pickRemoteMime(url, response.headers.get("content-type"));
    if (!mimeType)
        throw new Error(
            `cannot tell the media type of ${url}; use a URL with a known file extension`
        );

    const directory = await mkdtemp(path.join(tmpdir(), "plelude-"));
    const cleanup = () => rm(directory, { recursive: true, force: true });
    const file = path.join(
        directory,
        `media${path.extname(new URL(url).pathname) || ""}`
    );
    try {
        await writeStream(response.body, file);
    } catch (error) {
        await cleanup();
        throw error;
    }
    return { path: file, mimeType, cleanup };
}

async function writeStream(
    body: ReadableStream<Uint8Array>,
    file: string
): Promise<void> {
    const output = createWriteStream(file);
    const reader = body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!output.write(value)) await once(output, "drain");
        }
    } finally {
        reader.releaseLock();
        output.end();
        await once(output, "finish");
    }
}
