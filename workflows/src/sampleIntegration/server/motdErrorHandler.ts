import type { PolyServerFunction } from "polyapi";

export const polyConfig: PolyServerFunction = {
    name: "motdErrorHandler",
    context: "covetrus.sampleIntegration",
    description:
        "Error handler for the motd flow. Called directly by motdServer's catch block when motdClient fails, regardless of whether motdServer was invoked by the webhook or the scheduler. Also wired as the destination of motdErrorHandlerTrigger, a platform error-handler trigger on the /motd webhook path, as a safety net for exceptions motdServer's own catch block never sees. Logs the error and returns a normalized error payload.",
    logsEnabled: true,
};

export type MotdErrorEvent = {
    message?: string;
    functionName?: string;
    functionContext?: string;
};

/**
 * Builds one message from the error event, logs it, and returns it as the
 * caller-facing payload — so the log and the response never drift apart.
 * @param {MotdErrorEvent} errorEvent - The error event passed by motdServer or by motdErrorHandlerTrigger.
 * @returns {{ message: string }} A normalized error response.
 */
export function motdErrorHandler(errorEvent: MotdErrorEvent): { message: string } {
    const source = errorEvent.functionName ?? "unknown function";
    const detail = errorEvent.message ?? JSON.stringify(errorEvent);
    const message = `motd request failed in ${source}: ${detail}`;

    console.error(message);

    return { message };
}
