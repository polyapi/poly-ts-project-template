import Module from 'node:module';
import path from 'node:path';

const SOURCE_PATH_MARKER = `${path.sep}workflows${path.sep}src${path.sep}`;
const AVA_HELPER_PATH = `${path.sep}utilities${path.sep}common${path.sep}test${path.sep}ava.ts`;
const mockedModulePaths = new Set<string>();

export type MockFunction = ((...args: unknown[]) => unknown) & {
  calls: unknown[][];
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  mockRejectedValue: (error: unknown) => void;
};

export function fn(): MockFunction {
  let implementation: (...args: unknown[]) => unknown = () => undefined;

  const mock = ((...args: unknown[]) => {
    mock.calls.push(args);
    return implementation(...args);
  }) as MockFunction;

  mock.calls = [];
  mock.mockReset = () => {
    mock.calls = [];
    implementation = () => undefined;
  };
  mock.mockResolvedValue = value => {
    implementation = () => Promise.resolve(value);
  };
  mock.mockRejectedValue = error => {
    implementation = () => Promise.reject(error);
  };

  return mock;
}

export function mockModule(moduleName: string, mockExports: unknown): void {
  const modulePath = require.resolve(moduleName);
  const mockedModule = new Module(modulePath);
  mockedModule.filename = modulePath;
  mockedModule.loaded = true;
  mockedModule.exports = mockExports;
  require.cache[modulePath] = mockedModule;
  mockedModulePaths.add(modulePath);
}

export function clearMockFunctions(
  mocks: Record<string, { mockReset: () => void }>
): void {
  for (const mock of Object.values(mocks)) mock.mockReset();
}

export function stubConsole(method: 'info' | 'warn' | 'error'): {
  spy: MockFunction;
  restore: () => void;
} {
  const original = console[method];
  const spy = fn();
  console[method] = spy;

  return {
    spy,
    restore: () => {
      console[method] = original;
    },
  };
}

export function resetModules(): void {
  for (const modulePath of mockedModulePaths) delete require.cache[modulePath];
  mockedModulePaths.clear();

  for (const modulePath of Object.keys(require.cache)) {
    if (
      modulePath.includes(SOURCE_PATH_MARKER) &&
      !modulePath.endsWith(AVA_HELPER_PATH)
    ) {
      delete require.cache[modulePath];
    }
  }
}
