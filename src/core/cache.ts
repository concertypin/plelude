import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import * as z from "zod";

/** A cached upload is reused only while at least this much lifetime remains. */
const MIN_REMAINING_MS = 60 * 60 * 1000;

export const uploadEntrySchema = z.object({
    /** Resource name, e.g. `files/abc123`. */
    name: z.string().min(1),
    /** URI to pass as `file_data` / `uri` in interaction input. */
    uri: z.string().min(1),
    mimeType: z.string().min(1),
    /** ISO 8601 expiry time reported by the Files API. */
    expiresAt: z.string().min(1),
});

export type UploadEntry = z.output<typeof uploadEntrySchema>;

export type UploadCache = Record<string, UploadEntry>;

const uploadCacheSchema = z.record(z.string(), uploadEntrySchema);

/**
 * Short, non-reversible identifier of an API key. Cache entries are scoped by it, so a key
 * never appears in the cache file.
 */
export function keyFingerprint(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/**
 * Builds the cache key for a local file. Changing the file, its size, its mtime, or the API key
 * produces a new key, so stale uploads are never reused.
 */
export function uploadCacheKey(parts: {
    absPath: string;
    size: number;
    mtimeMs: number;
    fingerprint: string;
}): string {
    return [
        parts.absPath,
        parts.size,
        Math.trunc(parts.mtimeMs),
        parts.fingerprint,
    ].join("|");
}

/**
 * Parses an ISO timestamp. Date cannot read more than millisecond precision, which the Files API
 * sends, so extra digits are trimmed first.
 *
 * @returns Epoch milliseconds, or `NaN` when the input is not a timestamp.
 */
export function parseIsoMs(iso: string): number {
    return Date.parse(iso.replace(/(\.\d{3})\d+/, "$1"));
}

/**
 * Reads the upload cache. A missing or corrupt file is treated as an empty cache, because the
 * cache only saves re-uploads and losing it is never a correctness problem.
 */
export function readUploadCache(file: string): UploadCache {
    if (!existsSync(file)) return {};
    try {
        const parsed = uploadCacheSchema.safeParse(
            JSON.parse(readFileSync(file, "utf8"))
        );
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/**
 * Returns the cached upload for `key` if it is still valid for at least the reuse margin.
 */
export function findUpload(
    cache: UploadCache,
    key: string,
    nowMs: number
): UploadEntry | undefined {
    const entry = cache[key];
    if (!entry) return undefined;
    return parseIsoMs(entry.expiresAt) - nowMs >= MIN_REMAINING_MS
        ? entry
        : undefined;
}

/**
 * Stores an upload and drops entries that have already expired.
 *
 * Two plelude processes writing at once can lose one entry (last write wins). That only costs
 * a re-upload, so no lock is taken.
 */
export function saveUpload(
    file: string,
    key: string,
    entry: UploadEntry,
    nowMs: number
): void {
    const kept: UploadCache = Object.fromEntries(
        Object.entries(readUploadCache(file)).filter(
            ([, value]) => parseIsoMs(value.expiresAt) > nowMs
        )
    );
    kept[key] = entry;
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(kept, null, 2)}\n`);
    renameSync(temporary, file);
}
