import { EXIT, formatUsage, type CliDeps, type ExitCode } from "@/cli/shared";
import {
    configFilePath,
    configSchema,
    readConfigFile,
    updateConfigFile,
    writeConfigFile,
} from "@/core/config";

export const CONFIG_KEYS = [
    "apiKey",
    "baseUrl",
    "model",
    "thinkingLevel",
    "resolution",
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const CONFIG_HELP = `Usage:
  plelude config set <key> <value>     store a value (not for apiKey: see below)
  plelude config set apiKey            read the key without echo (terminal), or from stdin (pipe)
  plelude config get <key>             print a value (the key is partly masked)
  plelude config unset <key>           remove a value
  plelude config path                  print the config file location

Keys: ${CONFIG_KEYS.join(", ")}
Pass the key through stdin so it never lands in shell history, e.g.: printf %s "$KEY" | plelude config set apiKey
`;

function isConfigKey(value: string): value is ConfigKey {
    return (CONFIG_KEYS as readonly string[]).includes(value);
}

/**
 * Shows a secret without revealing it.
 */
export function maskSecret(value: string): string {
    if (value.length <= 8) return "********";
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Runs `plelude config` and returns the exit code.
 */
export async function runConfig(
    args: readonly string[],
    deps: CliDeps
): Promise<ExitCode> {
    const [action, key, ...rest] = args;

    if (action === undefined || action === "--help" || action === "-h") {
        deps.write(CONFIG_HELP);
        return EXIT.ok;
    }
    if (action === "path") {
        deps.write(`${configFilePath(deps.env)}\n`);
        return EXIT.ok;
    }
    if (key === undefined || !isConfigKey(key)) {
        deps.write(formatUsage(`expected a key: ${CONFIG_KEYS.join(", ")}`));
        return EXIT.usage;
    }

    if (action === "get") {
        const value = readConfigFile(deps.env)[key];
        if (value === undefined) {
            deps.write("[plelude] not set\n");
            return EXIT.ok;
        }
        deps.write(`${key === "apiKey" ? maskSecret(value) : value}\n`);
        return EXIT.ok;
    }

    if (action === "unset") {
        const next = { ...readConfigFile(deps.env) };
        delete next[key];
        writeConfigFile(next, deps.env);
        deps.write(`[plelude] unset ${key}\n`);
        return EXIT.ok;
    }

    if (action === "set") {
        const value = await valueFor(key, rest, deps);
        if (!value.ok) {
            deps.write(formatUsage(value.error));
            return EXIT.usage;
        }
        const parsed = configSchema.safeParse({ [key]: value.value });
        if (!parsed.success) {
            deps.write(
                formatUsage(
                    `invalid ${key}: ${parsed.error.issues[0]?.message ?? "rejected"}`
                )
            );
            return EXIT.usage;
        }
        updateConfigFile(parsed.data, deps.env);
        deps.write(`[plelude] saved ${key}\n`);
        return EXIT.ok;
    }

    deps.write(
        formatUsage(
            `unknown config action "${action}". Use set, get, unset, or path`
        )
    );
    return EXIT.usage;
}

/**
 * Gets the value for `config set`. A value on the command line is accepted for every key except apiKey,
 * because a key typed as an argument would be kept in shell history. For apiKey the value comes from a
 * terminal prompt without echo, or from stdin when it is piped.
 */
async function valueFor(
    key: ConfigKey,
    rest: readonly string[],
    deps: CliDeps
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
    if (key === "apiKey" && rest.length > 0) {
        return {
            ok: false,
            error: "apiKey is never accepted as an argument. Use the prompt, or pipe it through stdin",
        };
    }
    if (key !== "apiKey") {
        if (rest.length !== 1)
            return {
                ok: false,
                error: `expected exactly one value for ${key}`,
            };
        return { ok: true, value: rest[0] ?? "" };
    }
    const value = deps.isTTY ? await deps.readSecret() : await deps.readStdin();
    const trimmed = value.trim();
    return trimmed === ""
        ? { ok: false, error: "no API key given" }
        : { ok: true, value: trimmed };
}
