import { readFileSync } from "node:fs";

/**
 * Runtime dependency sections read from package.json.
 */
export type PackageManifest = {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
};

/**
 * Determines whether a package manifest dependency section maps names to version strings.
 */
function isDependencyMap(value: unknown): value is Record<string, string> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string")
    );
}

/**
 * Narrows parsed package.json data to the runtime dependency fields used for externalization.
 */
function isPackageManifest(value: unknown): value is PackageManifest {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const dependencies =
        "dependencies" in value ? value.dependencies : undefined;
    const peerDependencies =
        "peerDependencies" in value ? value.peerDependencies : undefined;

    return (
        (dependencies === undefined || isDependencyMap(dependencies)) &&
        (peerDependencies === undefined || isDependencyMap(peerDependencies))
    );
}

/**
 * Loads and validates runtime dependency declarations from the repository package.json.
 *
 * @throws {TypeError} When dependencies or peerDependencies is not a string map.
 */
function loadPackageManifest(): PackageManifest {
    const manifest: unknown = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );

    if (!isPackageManifest(manifest)) {
        throw new TypeError(
            "package.json dependencies and peerDependencies must be string maps."
        );
    }

    return manifest;
}

/**
 * Creates a predicate that externalizes declared runtime dependencies.
 *
 * A package's subpath imports are externalized together with its root import.
 */
export function createExternalPackagePredicate({
    dependencies,
    peerDependencies,
}: PackageManifest) {
    const runtimePackages = [
        ...new Set([
            ...Object.keys(dependencies ?? {}),
            ...Object.keys(peerDependencies ?? {}),
        ]),
    ];

    return (id: string) =>
        runtimePackages.some(
            (packageName) =>
                id === packageName || id.startsWith(`${packageName}/`)
        );
}

/**
 * Externalizes the runtime packages declared by this template's package.json.
 */
export const isExternalRuntimePackage = createExternalPackagePredicate(
    loadPackageManifest()
);
