import poly, { type PolyServerFunction } from 'polyapi';

export const polyConfig: PolyServerFunction = {
  name: 'motdServer',
  context: 'example.sampleWorkflow',
  description:
    'Greets the caller by name, adding a message of the day chosen by motdClient based on mood.',
  logsEnabled: true,
  serverSideAsync: false,
};

export type MotdPayload = {
  name: string;
  mood: 'funny' | 'wise';
};

export type MotdResponse = {
  statusCode: number;
  message: string;
};

/**
 * Greets the caller by name, adding a message of the day chosen by motdClient based on mood.
 * @param {MotdPayload} eventPayload - The webhook payload containing the caller's name and mood.
 * @returns {Promise<MotdResponse>} statusCode 200 with the combined greeting message, or
 * statusCode 500 with motdErrorHandler's normalized message if motdClient fails.
 */
export async function motdServer(
  eventPayload: MotdPayload
): Promise<MotdResponse> {
  try {
    const content = await poly.sample.sampleWorkflow.motdClient(
      eventPayload.mood
    );
    return {
      statusCode: 200,
      message: `Hi ${eventPayload.name}! ${content}`,
    };
  } catch (error) {
    const handled = await poly.sample.sampleWorkflow.motdErrorHandler({
      message: error instanceof Error ? error.message : String(error),
      functionName: 'motdClient',
      functionContext: 'example.sampleWorkflow',
    });
    return {
      statusCode: 500,
      message: handled.message,
    };
  }
}
