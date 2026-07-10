/**
 * Namespace validation utilities
 *
 * Enforces that all artifacts (schemas, webhooks, functions, triggers, variables, ...)
 * are properly namespaced within one of the required POLYAPI_NAMESPACES.
 *
 * Deviation from upstream Flow: this project's already-deployed PolyAPI resources
 * are split across multiple top-level context prefixes (e.g. "bbf", "ohip", "configs",
 * "creds") rather than a single tenant namespace, so this file replaces the original
 * single-POLYAPI_NAMESPACE check with a comma-separated allow-list. Keep this in mind
 * when syncing future upstream Flow changes into cli/.
 */

import chalk from "chalk";
import { logger } from "./logger";

/**
 * Get the required namespaces from environment variables.
 * Reads the comma-separated POLYAPI_NAMESPACES if set, otherwise falls back to the
 * single POLYAPI_NAMESPACE (upstream Flow's original single-namespace variable).
 * @throws Error if neither POLYAPI_NAMESPACES nor POLYAPI_NAMESPACE is set
 */
export function getRequiredNamespaces(): string[] {
    const namespacesList = process.env.POLYAPI_NAMESPACES;

    if (namespacesList && namespacesList.trim() !== "") {
        const namespaces = namespacesList
            .split(",")
            .map((namespace) => namespace.trim())
            .filter((namespace) => namespace.length > 0);

        if (namespaces.length > 0) {
            return namespaces;
        }
    }

    const namespace = process.env.POLYAPI_NAMESPACE;

    if (!namespace || namespace.trim() === "") {
        throw new Error(
            "POLYAPI_NAMESPACES (or POLYAPI_NAMESPACE) environment variable is required but not set. " +
                "Please set it in your dev.env file (e.g., POLYAPI_NAMESPACES=bbf,ohip,configs,creds)",
        );
    }

    return [namespace.trim()];
}

/**
 * Get the required namespace from environment variable.
 * @deprecated prefer getRequiredNamespaces() — kept for compatibility with any
 * remaining single-namespace call sites and error messages.
 * @throws Error if no namespace is configured
 */
export function getRequiredNamespace(): string {
    return getRequiredNamespaces()[0];
}

/**
 * Validate that a context string starts with one of the required namespaces
 * @param context - The context string to validate (e.g., "bbf.zoom.phone")
 * @param artifactType - The type of artifact being validated (for error messages)
 * @param artifactName - The name of the artifact being validated (for error messages)
 * @returns true if valid, throws error if invalid
 * @throws Error if context doesn't start with any required namespace
 */
export function validateNamespace(context: string, artifactType: string, artifactName: string): boolean {
    const namespaces = getRequiredNamespaces();

    if (!context || typeof context !== "string") {
        throw new Error(`${artifactType} "${artifactName}" has invalid context: context must be a non-empty string`);
    }

    const matchedNamespace = namespaces.find((namespace) => {
        const validPattern = new RegExp(`^${escapeRegExp(namespace)}(\\.|$)`);
        return validPattern.test(context);
    });

    if (!matchedNamespace) {
        throw new Error(
            `${artifactType} "${artifactName}" has invalid context "${context}". ` +
                `All contexts must start with one of the configured namespaces [${namespaces.join(", ")}] ` +
                `(e.g., "${namespaces[0]}.module.submodule")`,
        );
    }

    logger.debug(
        {
            artifactType,
            artifactName,
            context,
            namespace: matchedNamespace,
        },
        "Namespace validation passed",
    );

    return true;
}

/**
 * Check whether a context string starts with any of the required namespaces.
 * Use this in place of `context?.startsWith(namespace)` for orphan-detection /
 * existing-resource scoping, since this project has more than one namespace.
 */
export function matchesAnyRequiredNamespace(context: string | null | undefined): boolean {
    if (!context) {
        return false;
    }

    const namespaces = getRequiredNamespaces();
    return namespaces.some((namespace) => context.startsWith(namespace));
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Print namespace enforcement banner
 */
export function printNamespaceBanner(): void {
    const namespaces = getRequiredNamespaces();
    logger.info(chalk.gray(`Namespace(s): ${chalk.cyan(namespaces.join(", "))}`));
}
