/// <reference types="vitest/config" />

import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type UserConfig } from "vite";
import dts from "vite-plugin-dts";

import { isExternalRuntimePackage } from "./scripts/external-packages.ts";

const resolve = {
    alias: {
        "@": fileURLToPath(new URL("src", import.meta.url)),
    },
} satisfies UserConfig["resolve"];

const testConfig = {
    coverage: {
        enabled: true,
        include: ["src/**/*.ts"],
        provider: "v8",
        reportOnFailure: true,
        reporter: ["text", "json-summary", "html"],
    },
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: "./tests/setup.ts",
} satisfies NonNullable<UserConfig["test"]>;

/**
 * The command-line entry is a plain file, not an `index.ts`, so it is listed explicitly.
 */
const CLI_ENTRY = "cli/bin";

const entries = Object.fromEntries(
    [...globSync("src/**/index.ts"), "src/cli/bin.ts"].map((file) => {
        const relativePath = path.relative("src", file);
        const entryName = relativePath.replace(/\.ts$/, "").replace(/\\/g, "/");

        return [
            entryName,
            fileURLToPath(new URL(file, import.meta.url)),
        ] satisfies [string, string];
    })
);
export default defineConfig({
    build: {
        lib: {
            entry: entries,
            formats: ["es"],
        },
        rolldownOptions: {
            // Node built-ins keep their `node:` specifiers. The browser stubs Vite would otherwise use break the CLI.
            external: (id) =>
                id.startsWith("node:") || isExternalRuntimePackage(id),
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "internal/[name]-[hash].js",
                // Only the command-line entry runs directly, so only it needs a shebang.
                banner: (chunk) =>
                    chunk.name === CLI_ENTRY ? "#!/usr/bin/env node" : "",
            },
        },
        outDir: "dist",
        sourcemap: true,
        minify: false,
    },
    clearScreen: false,
    plugins: [
        dts({
            tsconfigPath: "./tsconfig.app.json",
            outDirs: "dist",
            entryRoot: "src",
            include: ["src/**/index.ts"],
        }),
    ],
    resolve,
    test: testConfig,
});
