import { runAsk } from "@/cli/ask";
import { runConfig } from "@/cli/config-command";
import { MAIN_HELP } from "@/cli/help";
import { EXIT, formatUsage, type CliDeps, type ExitCode } from "@/cli/shared";
import { runUpload } from "@/cli/upload";
import { VERSION } from "@/cli/version";

/**
 * Dispatches a `plelude` command line and returns the process exit code.
 *
 * @param argv - Arguments after the program name.
 */
export async function main(
    argv: readonly string[],
    deps: CliDeps
): Promise<ExitCode> {
    const [command, ...rest] = argv;

    if (
        command === undefined ||
        command === "--help" ||
        command === "-h" ||
        command === "help"
    ) {
        deps.write(MAIN_HELP);
        return command === undefined ? EXIT.usage : EXIT.ok;
    }
    if (command === "--version" || command === "-v") {
        deps.write(`${VERSION}\n`);
        return EXIT.ok;
    }

    try {
        switch (command) {
            case "ask":
                return await runAsk(rest, deps);
            case "upload":
                return await runUpload(rest, deps);
            case "config":
                return await runConfig(rest, deps);
            default:
                deps.write(
                    formatUsage(
                        `unknown command "${command}". Run plelude --help`
                    )
                );
                return EXIT.usage;
        }
    } catch (error) {
        // Failures not handled inside a command (for example an unreadable config file) still go to
        // stdout, so an agent reading stdout sees them.
        deps.write(
            formatUsage(error instanceof Error ? error.message : String(error))
        );
        return EXIT.gemini;
    }
}
