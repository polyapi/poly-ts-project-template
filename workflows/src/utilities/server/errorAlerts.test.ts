import test from 'ava';
import errorAlerts from './errorAlerts';

test.serial('logs a sanitized error event', async t => {
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (message?: unknown) => {
    messages.push(String(message));
  };

  t.teardown(() => {
    console.error = originalError;
  });

  await errorAlerts({
    message: 'Something failed',
    status: 500,
    data: {
      requestId: 'req-123',
      token: 'secret-token',
    },
  });

  t.is(messages.length, 1);
  t.true(messages[0].includes('Something failed'));
  t.true(messages[0].includes('[REDACTED]'));
  t.false(messages[0].includes('secret-token'));
});

test.serial('does not throw when console logging fails', async t => {
  const originalError = console.error;
  console.error = () => {
    throw new Error('console unavailable');
  };

  t.teardown(() => {
    console.error = originalError;
  });

  await t.notThrowsAsync(() => errorAlerts({ message: 'Failure' }));
});
