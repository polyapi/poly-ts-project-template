import test from 'ava';
import { fn, mockModule } from '../../utilities/common/test/ava';

const logMock = fn();

mockModule('polyapi', {
  __esModule: true,
  default: { example: { utilities: { log: logMock } } },
});

const { motdErrorHandler } =
  require('./motdErrorHandler') as typeof import('./motdErrorHandler');

test.beforeEach(() => {
  logMock.mockReset();
  logMock.mockResolvedValue(undefined);
});

test.serial(
  'logs the failure at warn through the shared logger and returns the same message',
  async t => {
    const result = await motdErrorHandler({
      message: 'getRandomAdvice failed with status 500',
      functionName: 'motdClient',
      functionContext: 'example.sampleWorkflow',
    });

    const expected =
      'motd request failed in motdClient: getRandomAdvice failed with status 500';
    t.deepEqual(result, { message: expected });
    t.is(logMock.calls.length, 1);
    t.deepEqual(logMock.calls[0], [
      'warn',
      'motdErrorHandler',
      expected,
      { functionName: 'motdClient', functionContext: 'example.sampleWorkflow' },
    ]);
  }
);

test.serial(
  'falls back to the serialized event when the trigger payload has no message',
  async t => {
    const result = await motdErrorHandler({
      functionContext: 'example.sampleWorkflow',
    });

    t.is(
      result.message,
      'motd request failed in unknown function: {"functionContext":"example.sampleWorkflow"}'
    );
    t.is(logMock.calls[0][0], 'warn');
  }
);
