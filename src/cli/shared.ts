import type { AnalysisEvent } from "@/core/analyze";
import { redactKey, type GeminiPort } from "@/core/gemini";

/**
 * Exit codes. Agents branch on these, so they are stable.
 */
export const EXIT = {
    ok: 0,
    /** Gemini or the network failed. */
    gemini: 1,
    /** Bad arguments or input. */
    usage: 2,
    /** No API key is configured. */
    noKey: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Side effects the CLI needs. Production wires real stdout, stdin, environment and clock;
 * tests supply fakes.
 */
export interface CliDeps {
    write(text: string): void;
    readStdin(): Promise<string>;
    /** Whether stdin is an interactive terminal. */
    isTTY: boolean;
    /** Reads one line from the terminal without echoing it. Only called when {@link isTTY} is true. */
    readSecret(): Promise<string>;
    env: NodeJS.ProcessEnv;
    now(): number;
    createPort(options: {
        apiKey: string;
        baseUrl?: string | undefined;
    }): GeminiPort;
}

/**
 * Everything `analyzeWith` needs to know about one analysis run.
 */
export interface AnalysisRun {
    events: AsyncIterable<AnalysisEvent>;
    ephemeral: boolean;
}

/**
 * A usage error line in the stdout format.
 */
export function formatUsage(message: string): string {
    return `[plelude] error: ${message}\n`;
}

/**
 * Streams one analysis to stdout (or prints one JSON object with `--json`).
 *
 * `prepare` runs after the Gemini port exists and returns the events to print. Its failures are reported
 * the same way as analysis failures.
 */
export async function analyzeWith(
    options: {
        deps: CliDeps;
        json: boolean;
        apiKey: string;
        baseUrl: string | undefined;
    },
    prepare: (port: GeminiPort) => Promise<AnalysisRun>
): Promise<ExitCode> {
    const { deps, json } = options;
    const port = deps.createPort({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
    });

    let atLineStart = true;
    const out = (chunk: string): void => {
        if (chunk.length === 0 || json) return;
        deps.write(chunk);
        atLineStart = chunk.endsWith("\n");
    };
    const line = (text: string): void => {
        if (!atLineStart) out("\n");
        out(`${text}\n`);
    };

    let sessionId: string | undefined;
    let answer = "";
    let doneId: string | undefined;
    let ephemeral = false;

    try {
        const run = await prepare(port);
        ephemeral = run.ephemeral;
        for await (const event of run.events) {
            switch (event.type) {
                case "session":
                    sessionId = event.id;
                    line(`[plelude] session=${event.id}`);
                    break;
                case "text":
                    answer += event.text;
                    out(event.text);
                    break;
                case "retry":
                    line(`[plelude] retry ${event.attempt}: ${event.reason}`);
                    break;
                case "done":
                    doneId = event.id;
                    break;
            }
        }
    } catch (error) {
        const message = redactKey(
            error instanceof Error ? error.message : String(error),
            options.apiKey
        );
        if (json) {
            deps.write(
                `${JSON.stringify({ session: sessionId ?? null, text: answer, error: message })}\n`
            );
        } else {
            line(`[plelude] error: ${message}`);
        }
        return EXIT.gemini;
    }

    if (json) {
        deps.write(
            `${JSON.stringify({ session: doneId ?? null, text: answer, error: null })}\n`
        );
        return EXIT.ok;
    }
    if (ephemeral) {
        line("[plelude] done (ephemeral, not stored)");
    } else {
        const id = doneId ?? sessionId ?? "unknown";
        line(
            `[plelude] done session=${id}  follow-up: plelude ask -c ${id} "<question>"`
        );
    }
    return EXIT.ok;
}
