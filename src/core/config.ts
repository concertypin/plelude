import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

import * as z from "zod";

import { resolveConfigDir } from "@/core/paths";

/**
 * Persisted settings in `config.json`. Every field is optional; unknown keys are rejected.
 */
export const configSchema = z
    .object({
        /** Gemini API key. `GEMINI_API_KEY` in the environment takes precedence. */
        apiKey: z.string().min(1).optional(),
        /** Overrides the Gemini API base URL (for proxies or testing). */
        baseUrl: z.url().optional(),
        /** Default model, used when `--model` is not given. */
        model: z.string().min(1).optional(),
        /** Default thinking level, used when `--thinking-level` is not given. */
        thinkingLevel: z.enum(["minimal", "low", "medium", "high"]).optional(),
        /** Default media resolution, used when `--resolution` is not given. */
        resolution: z.enum(["low", "medium", "high"]).optional(),
    })
    .strict();

export type PluginConfig = z.output<typeof configSchema>;

/**
 * Path of `config.json` inside the plelude config directory.
 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(resolveConfigDir(env), "config.json");
}

/**
 * Reads and validates `config.json`. A missing file means empty settings.
 *
 * @throws {Error} When the file exists but is not valid JSON or fails validation.
 */
export function readConfigFile(
    env: NodeJS.ProcessEnv = process.env
): PluginConfig {
    const file = configFilePath(env);
    if (!existsSync(file)) return {};
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return configSchema.parse(raw);
}

/**
 * Writes the full settings object to `config.json`, replacing what was there.
 *
 * The file is written to a temporary name and renamed into place, so a crash never leaves
 * a half-written config. On Unix the file is created with mode 600 because it holds the API key.
 *
 * @returns The settings as written, after validation.
 */
export function writeConfigFile(
    config: PluginConfig,
    env: NodeJS.ProcessEnv = process.env
): PluginConfig {
    const next = configSchema.parse(config);
    const file = configFilePath(env);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(
        temporary,
        `${JSON.stringify(next, null, 2)}
`,
        {
            mode: 0o600,
        }
    );
    renameSync(temporary, file);
    return next;
}

/**
 * Merges `patch` into `config.json` and writes it back.
 *
 * @returns The settings as written.
 */
export function updateConfigFile(
    patch: PluginConfig,
    env: NodeJS.ProcessEnv = process.env
): PluginConfig {
    return writeConfigFile({ ...readConfigFile(env), ...patch }, env);
}

/**
 * Finds the Gemini API key. `GEMINI_API_KEY` wins over the config file.
 *
 * @returns The key and where it came from, or `undefined` when neither source has one.
 */
export function resolveApiKey(
    env: NodeJS.ProcessEnv = process.env
): { apiKey: string; source: "env" | "config" } | undefined {
    const fromEnv = env["GEMINI_API_KEY"]?.trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
    const fromFile = readConfigFile(env).apiKey;
    return fromFile ? { apiKey: fromFile, source: "config" } : undefined;
}
