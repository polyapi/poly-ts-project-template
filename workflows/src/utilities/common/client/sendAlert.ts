import poly, { type PolyClientFunction, polyCustom, vari } from 'polyapi';

interface SendSlackAlertArgs {
  message: string;
}

// biome-ignore lint/correctness/noUnusedVariables: polyConfig is read by the PolyAPI platform
const polyConfig: PolyClientFunction = {
  name: 'sendAlert',
  context: 'example.utilities.slack',
  description: 'Send an alert message to a Slack channel',
  visibility: 'ENVIRONMENT',
};

/**
 * Send an alert message to a Slack channel
 * @param {SendSlackAlertArgs} args
 * @returns {Promise<void>}
 */
async function sendAlert(args: SendSlackAlertArgs): Promise<void> {
  const start = Date.now();
  const correlationId = `slack_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const { message } = args;
  const channelId = await vari.example.configurations.slack.channelId.get();

  poly.example.utilities.log('info', 'sendAlert', 'start', {
    correlationId,
    channelId,
    messagePreview: message.slice(0, 200),
  });

  await poly.OOB.polyapi.internal.alerting.sendAlertToPoly({
    level: 'error',
    name: 'PolyAPI workflow alert',
    message,
    slack: {
      type: 'community',
      channelId,
      levels: ['error'],
    },
    executionId: polyCustom.executionId,
  });

  poly.example.utilities.log('info', 'sendAlert', 'success', {
    correlationId,
    durationMs: Date.now() - start,
  });
}

export default sendAlert;
