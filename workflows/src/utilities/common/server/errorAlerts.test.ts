import test from 'ava';
import { clearMockFunctions, fn, mockModule, resetModules } from '../test/ava';

const mocks = { sendAlert: fn() };

function installPolyapiMock(): void {
  mockModule('polyapi', {
    __esModule: true,
    default: {
      example: {
        utilities: {
          slack: { sendAlert: mocks.sendAlert },
        },
      },
    },
  });
}

test.beforeEach(() => {
  resetModules();
  clearMockFunctions(mocks);
  installPolyapiMock();
  mocks.sendAlert.mockResolvedValue(undefined);
});

test.afterEach(resetModules);

test.serial(
  'errorAlerts delegates application errors to sendAlert',
  async t => {
    const { default: errorAlerts } = require('./errorAlerts') as {
      default: (error: { message: string }) => Promise<void>;
    };

    await errorAlerts({ message: 'Serialized error payload' });

    t.deepEqual(mocks.sendAlert.calls, [
      [
        {
          message: JSON.stringify(
            { message: 'Serialized error payload' },
            null,
            2
          ),
        },
      ],
    ]);
  }
);

test.serial('errorAlerts propagates sendAlert failures', async t => {
  const expectedError = new Error('alerting unavailable');
  mocks.sendAlert.mockRejectedValue(expectedError);
  const { default: errorAlerts } = require('./errorAlerts') as {
    default: (error: { message: string }) => Promise<void>;
  };

  await t.throwsAsync(
    () => errorAlerts({ message: 'Serialized error payload' }),
    { is: expectedError }
  );
});
