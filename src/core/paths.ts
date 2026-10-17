import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolves the plelude config directory: `$XDG_CONFIG_HOME/plelude`, falling back to `~/.config/plelude`.
 *
 * @param env - Environment to read `XDG_CONFIG_HOME` from.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const base = env["XDG_CONFIG_HOME"] || path.join(homedir(), ".config");
    return path.join(base, "plelude");
}

/**
 * Path of the upload cache (`files.json`) inside the plelude config directory.
 */
export function uploadCacheFilePath(
    env: NodeJS.ProcessEnv = process.env
): string {
    return path.join(resolveConfigDir(env), "files.json");
}
