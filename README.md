> [!NOTE]
> This is template repository for library development using TypeScript and Vite. Check out [website template](https://github.com/templecon/template-typescript-vite-web) for web application development.

# How to use

```bash
git clone https://github.com/templecon/template-typescript-vite
cd template-typescript-vite
pnpm install
```

## Requirements

Node.js 26 or higher is required. The template runs TypeScript configuration and hooks directly with Node's built-in type stripping.

The repository pins its package manager in the `packageManager` field of `package.json` (pnpm 10.17.1). Install that exact version with `npm install -g pnpm@10.17.1` before running `pnpm install` and `pnpm run check`. If Corepack has been installed separately, `corepack prepare pnpm@10.17.1 --activate` is an equivalent option.

## Library entrypoints

Every `src/**/index.ts` file is an ESM library entrypoint. The Vite configuration discovers these files automatically and emits matching JavaScript and declaration files under `dist/`.

| Source file            | Package import         |
| ---------------------- | ---------------------- |
| `src/index.ts`         | `your-package`         |
| `src/feature/index.ts` | `your-package/feature` |

## Publishing

This template is intentionally `private` so cloning it cannot accidentally publish the template itself. Before an initial public release, choose your package identity: set a unique `name` and release `version`, set `private` to `false`, and add the package's `repository` and `publishConfig.access` metadata.

The included **Publish** workflow uses npm Trusted Publishing with GitHub Actions OIDC. It has no npm token or registry secret. Configure the matching GitHub Actions trusted publisher in the package's npm settings after the package's initial registry release. The workflow runs automatically on every tag matching `v*.*.*` (for example `v0.1.0`) and publishes the package version referenced by that tag.

## Conventions and Rules

Project conventions are available from the conventions MCP server. The project agent guidance identifies the applicable TypeScript, schema, and Vitest conventions.
