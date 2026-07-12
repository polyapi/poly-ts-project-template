import test from 'ava';
import { clearMockFunctions, fn, mockModule, resetModules } from '../test/ava';

const mocks = {
  log: fn(),
  sendAlertToPoly: fn(),
  slackChannelIdGet: fn(),
};

function installPolyapiMock(): void {
  mockModule('polyapi', {
    __esModule: true,
    default: {
      OOB: {
        polyapi: {
          internal: {
            alerting: { sendAlertToPoly: mocks.sendAlertToPoly },
          },
        },
      },
      example: { utilities: { log: mocks.log } },
    },
    polyCustom: { executionId: 'execution-123' },
    vari: {
      example: {
        configurations: {
          slack: { channelId: { get: mocks.slackChannelIdGet } },
        },
      },
    },
  });
}

test.beforeEach(() => {
  resetModules();
  clearMockFunctions(mocks);
  installPolyapiMock();
  mocks.slackChannelIdGet.mockResolvedValue('C123');
  mocks.sendAlertToPoly.mockResolvedValue(undefined);
});

test.afterEach(resetModules);

test.serial('sendAlert sends a community Slack alert', async t => {
  const { default: sendAlert } = require('./sendAlert') as {
    default: (args: { message: string }) => Promise<void>;
  };

  await sendAlert({ message: 'Something failed' });

  t.deepEqual(mocks.sendAlertToPoly.calls, [
    [
      {
        level: 'error',
        name: 'PolyAPI workflow alert',
        message: 'Something failed',
        slack: {
          type: 'community',
          channelId: 'C123',
          levels: ['error'],
        },
        executionId: 'execution-123',
      },
    ],
  ]);
  t.is(mocks.log.calls.length, 2);
  const successContext = mocks.log.calls[1][3] as Record<string, unknown>;
  t.regex(String(successContext.correlationId), /^slack_\d+_[a-z0-9]+$/);
  t.is(typeof successContext.durationMs, 'number');
});

test.serial('sendAlert propagates internal alerting failures', async t => {
  const expectedError = new Error('alerting unavailable');
  mocks.sendAlertToPoly.mockRejectedValue(expectedError);
  const { default: sendAlert } = require('./sendAlert') as {
    default: (args: { message: string }) => Promise<void>;
  };

  await t.throwsAsync(() => sendAlert({ message: 'Something failed' }), {
    is: expectedError,
  });
});
