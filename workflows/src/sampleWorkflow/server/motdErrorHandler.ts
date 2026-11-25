import poly, { type PolyServerFunction } from 'polyapi';

export const polyConfig: PolyServerFunction = {
  name: 'motdErrorHandler',
  context: 'example.sampleWorkflow',
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
 *
 * Logs at warn, not error: this function is also an error-handler trigger
 * destination, and the shared logger raises an alert for error and fatal. An
 * alert raised from inside an error handler re-enters the alert path, so the
 * innermost catch that names the failure owns the alert instead.
 * @param {MotdErrorEvent} errorEvent - The error event passed by motdServer or by motdErrorHandlerTrigger.
 * @returns {Promise<{ message: string }>} A normalized error response.
 */
export async function motdErrorHandler(
  errorEvent: MotdErrorEvent
): Promise<{ message: string }> {
  const source = errorEvent.functionName ?? 'unknown function';
  const detail = errorEvent.message ?? JSON.stringify(errorEvent);
  const message = `motd request failed in ${source}: ${detail}`;

  await poly.example.utilities.log('warn', 'motdErrorHandler', message, {
    functionName: source,
    functionContext: errorEvent.functionContext,
  });

  return { message };
}
