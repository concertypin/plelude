import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");
const sourceRoot = resolve(projectRoot, "src");
const viteConfigFile = resolve(projectRoot, "vite.config.ts");

function entryName(sourcePath: string) {
    return relative(sourceRoot, sourcePath)
        .replace(/\.ts$/, "")
        .replace(/\\/g, "/");
}

describe("library build", () => {
    beforeAll(async () => {
        await build({ configFile: viteConfigFile });
    });

    it("emits JavaScript and declarations for every index entrypoint", () => {
        const entrypoints = globSync(resolve(sourceRoot, "**/index.ts"));

        expect(entrypoints).not.toHaveLength(0);

        for (const sourcePath of entrypoints) {
            const outputStem = resolve(
                projectRoot,
                "dist",
                entryName(sourcePath)
            );

            expect(existsSync(`${outputStem}.js`)).toBe(true);
            expect(existsSync(`${outputStem}.d.ts`)).toBe(true);
        }
    });

    it("resolves every entrypoint through package exports", async () => {
        const packageSubpaths = globSync(
            resolve(sourceRoot, "**/index.ts")
        ).map((sourcePath) => entryName(sourcePath).replace(/\/?index$/, ""));

        await expect(
            execFileAsync(
                process.execPath,
                [
                    "--input-type=module",
                    "--eval",
                    "const packageJson = (await import('./package.json', { with: { type: 'json' } })).default; for (const subpath of JSON.parse(process.argv[1])) await import(subpath ? `${packageJson.name}/${subpath}` : packageJson.name)",
                    JSON.stringify(packageSubpaths),
                ],
                { cwd: projectRoot }
            )
        ).resolves.toMatchObject({ stderr: "" });
    });
});
