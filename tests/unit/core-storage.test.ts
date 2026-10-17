import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    findUpload,
    keyFingerprint,
    parseIsoMs,
    readUploadCache,
    saveUpload,
    uploadCacheKey,
    type UploadEntry,
} from "@/core/cache";
import {
    configFilePath,
    readConfigFile,
    resolveApiKey,
    updateConfigFile,
} from "@/core/config";
import { resolveConfigDir } from "@/core/paths";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "plelude-test-"));
    env = { XDG_CONFIG_HOME: root };
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("resolveConfigDir", () => {
    it("uses XDG_CONFIG_HOME when it is set", () => {
        expect(resolveConfigDir({ XDG_CONFIG_HOME: "/x" })).toBe(
            path.join("/x", "plelude")
        );
    });

    it("falls back to ~/.config/plelude", () => {
        expect(resolveConfigDir({})).toMatch(/[\\/]\.config[\\/]plelude$/);
    });
});

describe("config file", () => {
    it("returns empty settings when no file exists", () => {
        expect(readConfigFile(env)).toEqual({});
    });

    it("merges patches and removes a key when it is set to undefined", () => {
        updateConfigFile({ apiKey: "k1", model: "m1" }, env);
        const next = updateConfigFile(
            { model: undefined, resolution: "low" },
            env
        );
        expect(next).toEqual({ apiKey: "k1", resolution: "low" });
        expect(readConfigFile(env)).toEqual({
            apiKey: "k1",
            resolution: "low",
        });
    });

    it("rejects an invalid base URL and unknown keys", () => {
        expect(() => updateConfigFile({ baseUrl: "not a url" }, env)).toThrow(
            /Invalid URL/
        );
        updateConfigFile({}, env);
        writeFileSync(
            configFilePath(env),
            JSON.stringify({ apiKey: "k", surprise: true })
        );
        expect(() => readConfigFile(env)).toThrow(/Unrecognized key/);
    });

    it("throws a clear error for malformed JSON instead of silently ignoring it", () => {
        updateConfigFile({ apiKey: "k" }, env);
        writeFileSync(configFilePath(env), "{ not json");
        expect(() => readConfigFile(env)).toThrow(/JSON/);
    });
});

describe("resolveApiKey", () => {
    it("prefers GEMINI_API_KEY over the config file", () => {
        updateConfigFile({ apiKey: "from-file" }, env);
        expect(resolveApiKey({ ...env, GEMINI_API_KEY: " from-env " })).toEqual(
            {
                apiKey: "from-env",
                source: "env",
            }
        );
    });

    it("falls back to the config file", () => {
        updateConfigFile({ apiKey: "from-file" }, env);
        expect(resolveApiKey(env)).toEqual({
            apiKey: "from-file",
            source: "config",
        });
    });

    it("returns undefined when neither source has a key", () => {
        expect(resolveApiKey(env)).toBeUndefined();
    });
});

const entry = (expiresAt: string): UploadEntry => ({
    name: "files/abc",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
    mimeType: "video/mp4",
    expiresAt,
});

describe("upload cache", () => {
    const now = Date.parse("2026-10-17T00:00:00Z");

    it("scopes keys by API key without storing the key", () => {
        const a = uploadCacheKey({
            absPath: "/v/a.mp4",
            size: 10,
            mtimeMs: 5,
            fingerprint: keyFingerprint("key-1"),
        });
        const b = uploadCacheKey({
            absPath: "/v/a.mp4",
            size: 10,
            mtimeMs: 5,
            fingerprint: keyFingerprint("key-2"),
        });
        expect(a).not.toBe(b);
        expect(a).not.toContain("key-1");
    });

    it("changes the key when the file changes", () => {
        const base = {
            absPath: "/v/a.mp4",
            size: 10,
            mtimeMs: 5,
            fingerprint: "f",
        };
        expect(uploadCacheKey(base)).not.toBe(
            uploadCacheKey({ ...base, mtimeMs: 6 })
        );
        expect(uploadCacheKey(base)).not.toBe(
            uploadCacheKey({ ...base, size: 11 })
        );
    });

    it("reuses an upload only while at least an hour of lifetime remains", () => {
        const cache = { k: entry(new Date(now + 2 * 3600_000).toISOString()) };
        expect(findUpload(cache, "k", now)).toBeDefined();
        const nearExpiry = {
            k: entry(new Date(now + 30 * 60_000).toISOString()),
        };
        expect(findUpload(nearExpiry, "k", now)).toBeUndefined();
        expect(findUpload(cache, "missing", now)).toBeUndefined();
    });

    it("treats an unparseable expiry as expired", () => {
        expect(findUpload({ k: entry("soon") }, "k", now)).toBeUndefined();
    });

    it("reads Files API timestamps with nanosecond precision", () => {
        expect(parseIsoMs("2026-10-19T08:03:10.276160977Z")).toBe(
            Date.parse("2026-10-19T08:03:10.276Z")
        );
    });

    it("stores an entry and drops expired ones on save", () => {
        const file = path.join(root, "files.json");
        saveUpload(file, "old", entry(new Date(now - 1000).toISOString()), now);
        saveUpload(
            file,
            "new",
            entry(new Date(now + 48 * 3600_000).toISOString()),
            now
        );
        expect(Object.keys(readUploadCache(file))).toEqual(["new"]);
    });

    it("treats a cache file with the wrong shape as empty", () => {
        const file = path.join(root, "files.json");
        writeFileSync(file, JSON.stringify({ k: { name: 1 } }));
        expect(readUploadCache(file)).toEqual({});
    });

    it("treats a corrupt cache file as empty", () => {
        const file = path.join(root, "files.json");
        writeFileSync(file, "{ broken");
        expect(readUploadCache(file)).toEqual({});
        saveUpload(
            file,
            "k",
            entry(new Date(now + 48 * 3600_000).toISOString()),
            now
        );
        expect(Object.keys(readUploadCache(file))).toEqual(["k"]);
    });
});
