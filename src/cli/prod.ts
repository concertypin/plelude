import type { CliDeps } from "@/cli/shared";
import { createGeminiPort } from "@/core/gemini";

/**
 * Reads all of stdin as text.
 */
async function readAllStdin(): Promise<string> {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) text += String(chunk);
    return text;
}

/**
 * Reads one line from the terminal with echo turned off. Backspace is supported; Ctrl-C cancels.
 */
function readSecretFromTerminal(): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        let value = "";
        const finish = (error?: Error) => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stderr.write("\n");
            if (error) reject(error);
            else resolve(value);
        };
        const onData = (chunk: string | Buffer) => {
            for (const char of String(chunk)) {
                if (char === "\r" || char === "\n") return finish();
                if (char === "\u0003") return finish(new Error("cancelled"));
                if (char === "\u007f" || char === "\b")
                    value = value.slice(0, -1);
                else value += char;
            }
        };
        process.stderr.write("Gemini API key (input hidden): ");
        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        stdin.on("data", onData);
        stdin.resume();
    });
}

/**
 * The real side effects: process stdout, stdin, environment, clock, and the Gemini client.
 */
export function productionDeps(): CliDeps {
    return {
        write: (text) => {
            process.stdout.write(text);
        },
        readStdin: readAllStdin,
        isTTY: process.stdin.isTTY === true,
        readSecret: readSecretFromTerminal,
        env: process.env,
        now: () => Date.now(),
        createPort: createGeminiPort,
    };
}
