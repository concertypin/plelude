import { main } from "@/cli/main";
import { productionDeps } from "@/cli/prod";

main(process.argv.slice(2), productionDeps()).then(
    (code) => {
        process.exitCode = code;
    },
    (error: unknown) => {
        process.stderr.write(
            `plelude: ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exitCode = 1;
    }
);
