import test from 'ava';
import {
  clearMockFunctions,
  fn,
  mockModule,
  resetModules,
  stubConsole,
} from '../test/ava';

const mocks = {
  logLevelGet: fn(),
  sendAlert: fn(),
};

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
    vari: {
      example: {
        configurations: {
          logging: { logLevel: { get: mocks.logLevelGet } },
        },
      },
    },
  });
}

test.beforeEach(() => {
  resetModules();
  clearMockFunctions(mocks);
  installPolyapiMock();
  mocks.logLevelGet.mockResolvedValue('debug');
});

test.afterEach(resetModules);

test.serial('log emits structured info logs without alerting', async t => {
  const { spy, restore } = stubConsole('info');
  const { default: log } = require('./log') as {
    default: (
      level: string,
      functionName: string,
      message: string,
      context?: Record<string, unknown>
    ) => Promise<void>;
  };

  try {
    await log('info', 'testFunction', 'started', { roomNumber: '202' });

    t.deepEqual(spy.calls, [
      ['[info][testFunction] started | context={"roomNumber":"202"}'],
    ]);
    t.is(mocks.sendAlert.calls.length, 0);
  } finally {
    restore();
  }
});

test.serial('log emits debug logs without alerting', async t => {
  const { spy, restore } = stubConsole('info');
  const { default: log } = require('./log') as {
    default: (
      level: string,
      functionName: string,
      message: string
    ) => Promise<void>;
  };

  try {
    await log('debug', 'testFunction', 'resolved details');

    t.deepEqual(spy.calls, [['[debug][testFunction] resolved details']]);
    t.is(mocks.sendAlert.calls.length, 0);
  } finally {
    restore();
  }
});

test.serial('log sanitizes warnings without alerting', async t => {
  const { spy, restore } = stubConsole('warn');
  const { default: log } = require('./log') as {
    default: (
      level: string,
      functionName: string,
      message: string,
      context?: Record<string, unknown>
    ) => Promise<void>;
  };

  try {
    await log('warn', 'testFunction', 'request failed', {
      authorization: 'Bearer secret',
      roomNumber: '202',
    });

    t.deepEqual(spy.calls, [
      ['[warn][testFunction] request failed | context={"roomNumber":"202"}'],
    ]);
    t.is(mocks.sendAlert.calls.length, 0);
  } finally {
    restore();
  }
});

test.serial('log sanitizes context before alerting for errors', async t => {
  const { spy, restore } = stubConsole('error');
  const { default: log } = require('./log') as {
    default: (
      level: string,
      functionName: string,
      message: string,
      context?: Record<string, unknown>
    ) => Promise<void>;
  };

  try {
    await log('error', 'testFunction', 'request failed', {
      authorization: 'Bearer secret',
      roomNumber: '202',
    });

    t.deepEqual(spy.calls, [
      ['[error][testFunction] request failed | context={"roomNumber":"202"}'],
    ]);
    t.deepEqual(mocks.sendAlert.calls, [
      [
        {
          message: JSON.stringify({
            message: '[error][testFunction] request failed',
            level: 'error',
            functionName: 'testFunction',
            context: { roomNumber: '202' },
          }),
        },
      ],
    ]);
  } finally {
    restore();
  }
});
