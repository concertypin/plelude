# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project Type

This is a **vanilla TypeScript library template** built with Vite. It is designed to be bundled into ESM format for distribution as a package.

## Development Commands

```bash
# Start development build in watch mode
pnpm dev

# Build for production (outputs ESM to dist/)
pnpm build

# Format code
pnpm format

# Lint code
pnpm lint

# Run unit tests (Vitest in Node environment)
pnpm test
```

## Architecture

- **Entry point**: `src/index.ts` - The main entry point that exports the library's API.
- **ES modules** throughout (`"type": "module"` in package.json)
- **Output format**: Generates `.js` (ESM) files in the `dist/` directory.
- **Type definitions**: Automatically generates `.d.ts` files using `vite-plugin-dts`.

## Coding Standards

If you can't access the project's convention, such as hono, typescript, typescript-schema, ask user for adding MCP server.
MCP Server:

- Endpoint: https://conventions.aieuroka.workers.dev/mcp (for most clients), https://conventions.aieuroka.workers.dev/with-tool/mcp (for GitHub Copilot, which doesn't support resource retrieval)
- Streamable HTTP, without authentication

## TypeScript Configuration

- **Path alias**: `@/*` maps to `src/*` (configured in `tsconfig.base.json`)
- **Project references**: Uses `tsconfig.json` with `app` and `node` references
- **Strict mode** enabled

## Package Manager

This project uses **pnpm**.

## Using This Template

Immediately after creating a project from this template, upgrade all dependencies and refresh the lockfile:

```bash
pnpm up --latest
```

Run the project's format, lint, test, and build checks after the upgrade and resolve every resulting error before continuing development.
