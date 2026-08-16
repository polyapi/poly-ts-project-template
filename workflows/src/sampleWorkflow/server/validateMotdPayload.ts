import type { PolyServerFunction } from 'polyapi';

export const polyConfig: PolyServerFunction = {
  name: 'validateMotdPayload',
  context: 'example.sampleWorkflow',
  description:
    'Validates the motd webhook payload for required fields and correct values.',
  logsEnabled: true,
};

/**
 * Validates the motd webhook payload for required fields and correct values.
 * @param {any} eventPayload - The motd event payload to validate.
 *                             Must be an object containing a non-empty `name` string and a `mood` that is
 *                             either "funny" or "wise"; otherwise the function returns false.
 * @returns {boolean} Returns true if the payload is valid, otherwise false.
 */
export function validateMotdPayload(eventPayload: any): boolean {
  if (
    !eventPayload ||
    typeof eventPayload.name !== 'string' ||
    eventPayload.name.trim() === ''
  ) {
    return false;
  }

  if (eventPayload.mood !== 'funny' && eventPayload.mood !== 'wise') {
    return false;
  }

  return true;
}
