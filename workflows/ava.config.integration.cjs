module.exports = {
  extensions: ['ts'],
  files: ['src/**/*.integration.test.ts'],
  require: ['ts-node/register'],
  timeout: '60s',
};
