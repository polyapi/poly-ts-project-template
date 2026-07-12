import poly, { type PolyClientFunction } from 'polyapi';

interface ErrorAlertArgs {
  message: string;
}

// biome-ignore lint/correctness/noUnusedVariables: polyConfig is read by the PolyAPI platform
const polyConfig: PolyClientFunction = {
  name: 'errorAlerts',
  context: 'example.diagnostics.services',
  description:
    'Send a Slack alert for an application error via the shared alert utility.',
  visibility: 'ENVIRONMENT',
};

async function errorAlerts(error: ErrorAlertArgs): Promise<void> {
  await poly.example.utilities.slack.sendAlert({
    message: JSON.stringify(error, null, 2),
  });
}

export default errorAlerts;
