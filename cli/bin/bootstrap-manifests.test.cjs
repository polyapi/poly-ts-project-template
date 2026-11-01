const assert = require('node:assert/strict');
const test = require('node:test');
const { planManifests } = require('./bootstrap-manifests.cjs');

function defaults() {
  return {
    rootCurrent: {},
    workflowsCurrent: {},
    rootTemplate: {
      name: 'template',
      version: '99.0.0',
      packageManager: 'pnpm@99.0.0',
      dependencies: { unrelated: '^99.0.0' },
      scripts: {
        flow: 'pnpm --filter flow-cli',
        workflows: 'ENVIRONMENT_SETUP_COMPLETE=true pnpm --filter workflows',
        test: 'template test',
        build: 'template build',
        postinstall: 'template postinstall',
      },
    },
    workflowsTemplate: {
      name: 'workflows',
      dependencies: { polyapi: '^99.0.0' },
      devDependencies: { 'flow-cli': 'workspace:*', typescript: '^99.0.0' },
      ava: { require: ['template runner'] },
      scripts: {
        push: 'pnpm --filter flow-cli run build && node ../cli/dist/cli.js push',
        'push:dry-run':
          'pnpm --filter flow-cli run build && node ../cli/dist/cli.js push --dry-run',
        'train-openapi': 'pnpm --filter flow-cli run train-openapi',
        'train-model': 'pnpm --filter flow-cli run train-model',
        'delete-content': 'pnpm --filter flow-cli run delete-content',
        logs: 'pnpm --filter flow-cli run logs',
        'train:openapi': 'pnpm --filter flow-cli run train:openapi',
        'delete:content': 'pnpm --filter flow-cli run delete:content',
        test: 'template test',
        postinstall: 'template postinstall',
      },
    },
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

test('only missing approved launchers are added; package settings and dependencies stay project-owned', () => {
  const input = defaults();
  input.rootCurrent = {
    name: 'customer-integrations',
    version: '3.8.2',
    private: true,
    packageManager: 'pnpm@10.0.0',
    dependencies: { 'custom-runtime': '^1.4.2' },
    devDependencies: { biome: '2.4.13' },
    pnpm: { overrides: { 'custom-runtime': '1.4.2' } },
    scripts: { test: 'custom test', deploy: 'custom deploy' },
    extra: { projectOwned: [false, null, { label: 'keep' }] },
  };
  input.workflowsCurrent = {
    name: 'customer-workflows',
    version: '2.1.1',
    dependencies: { polyapi: '^0.27.4', custom: '1.0.0' },
    devDependencies: { 'flow-cli': 'workspace:*', typescript: '~5.8.3' },
    ava: { require: ['ts-node/register/transpile-only'], timeout: '90s' },
    scripts: {
      test: 'custom workflow test',
      'test:all': 'custom all',
      postinstall: 'custom setup',
    },
  };
  const before = structuredClone(input);
  freezeDeep(input);
  const result = planManifests(input);
  const expectedRoot = structuredClone(before.rootCurrent);
  Object.assign(expectedRoot.scripts, {
    flow: input.rootTemplate.scripts.flow,
    workflows: input.rootTemplate.scripts.workflows,
  });
  const expectedWorkflows = structuredClone(before.workflowsCurrent);
  const expectedScripts = [
    'push',
    'push:dry-run',
    'train-openapi',
    'train-model',
    'delete-content',
    'logs',
    'train:openapi',
    'delete:content',
  ];
  for (const script of expectedScripts)
    expectedWorkflows.scripts[script] = input.workflowsTemplate.scripts[script];
  assert.deepEqual(result.root, expectedRoot);
  assert.deepEqual(result.workflows, expectedWorkflows);
  assert.equal(result.additions.length, 10);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(input, before);

  result.root.extra.projectOwned[2].label = 'output change';
  assert.equal(input.rootCurrent.extra.projectOwned[2].label, 'keep');
});

test('conflicting existing commands are retained and explicitly reported', () => {
  const input = defaults();
  input.rootCurrent = {
    scripts: {
      flow: 'node custom-flow.cjs',
      workflows: input.rootTemplate.scripts.workflows,
    },
  };
  input.workflowsCurrent = {
    scripts: {
      push: 'custom safe deploy',
      'train:openapi': 'bash custom-training.sh',
      logs: '',
    },
  };
  const result = planManifests(input);
  assert.equal(result.root.scripts.flow, 'node custom-flow.cjs');
  assert.equal(result.workflows.scripts.push, 'custom safe deploy');
  assert.equal(
    result.workflows.scripts['train:openapi'],
    'bash custom-training.sh'
  );
  assert.equal(result.workflows.scripts.logs, '');
  assert.deepEqual(
    result.conflicts.map(({ file, script }) => ({ file, script })),
    [
      { file: 'package.json', script: 'flow' },
      { file: 'workflows/package.json', script: 'push' },
      { file: 'workflows/package.json', script: 'logs' },
      { file: 'workflows/package.json', script: 'train:openapi' },
    ]
  );
  assert.equal(result.conflicts[0].current, input.rootCurrent.scripts.flow);
  assert.equal(result.conflicts[0].template, input.rootTemplate.scripts.flow);
  assert.ok(
    result.additions.every(
      addition =>
        !['flow', 'workflows', 'push', 'logs', 'train:openapi'].includes(
          addition.script
        )
    )
  );
});

test('planning is idempotent and matching existing commands are not reported as conflicts', () => {
  const input = defaults();
  const first = planManifests(input);
  const second = planManifests({
    ...input,
    rootCurrent: first.root,
    workflowsCurrent: first.workflows,
  });
  assert.deepEqual(second.root, first.root);
  assert.deepEqual(second.workflows, first.workflows);
  assert.deepEqual(second.additions, []);
  assert.deepEqual(second.conflicts, []);
});

test('missing template launchers do not create empty scripts or copy unapproved template settings', () => {
  const input = {
    rootCurrent: { name: 'root' },
    workflowsCurrent: { name: 'flows' },
    rootTemplate: { name: 'template' },
    workflowsTemplate: { scripts: { test: 'other' } },
  };
  const result = planManifests(input);
  assert.deepEqual(result.root, input.rootCurrent);
  assert.deepEqual(result.workflows, input.workflowsCurrent);
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.conflicts, []);
});

test('own __proto__ and constructor properties survive without prototype pollution', () => {
  const input = defaults();
  input.rootCurrent = JSON.parse(
    '{"__proto__":{"marker":"keep"},"constructor":{"project":"own"},"scripts":{"__proto__":"custom prototype command","constructor":"custom constructor command"}}'
  );
  input.workflowsCurrent = JSON.parse(
    '{"scripts":{"__proto__":"workflow custom"},"dependencies":{"__proto__":"project-owned-package"}}'
  );
  const result = planManifests(input);
  assert.equal(Object.getPrototypeOf(result.root), Object.prototype);
  assert.equal(Object.hasOwn(result.root, '__proto__'), true);
  assert.deepEqual(result.root.__proto__, { marker: 'keep' });
  assert.deepEqual(result.root.constructor, { project: 'own' });
  assert.equal(result.root.scripts.__proto__, 'custom prototype command');
  assert.equal(result.root.scripts.constructor, 'custom constructor command');
  assert.equal(
    result.workflows.dependencies.__proto__,
    'project-owned-package'
  );
  assert.equal({}.marker, undefined);
});

test('inherited prototype script values are not treated as project-owned JSON fields', () => {
  const input = defaults();
  input.rootCurrent = { scripts: Object.create({ flow: 'inherited command' }) };
  const result = planManifests(input);
  assert.equal(result.root.scripts.flow, input.rootTemplate.scripts.flow);
  assert.ok(result.additions.some(addition => addition.script === 'flow'));
  assert.deepEqual(result.conflicts, []);
});

for (const field of [
  'rootCurrent',
  'workflowsCurrent',
  'rootTemplate',
  'workflowsTemplate',
]) {
  test(`invalid ${field} scripts container is rejected without changing input`, () => {
    for (const scripts of [null, [], 'unexpected scripts', 42, false]) {
      const input = defaults();
      input[field] = { scripts };
      const before = structuredClone(input);
      assert.throws(
        () => planManifests(input),
        /scripts must be a JSON object/
      );
      assert.deepEqual(input, before);
    }
  });
}

test('invalid manifest containers and allowlisted template commands are rejected', () => {
  for (const value of [null, [], 'manifest', 1]) {
    assert.throws(
      () => planManifests({ ...defaults(), rootCurrent: value }),
      /package\.json must be a JSON object/
    );
  }
  const input = defaults();
  input.rootTemplate.scripts.flow = ['invalid command'];
  assert.throws(
    () => planManifests(input),
    /Template package\.json scripts\.flow must be a string/
  );
});

test('existing unusual script values are preserved and returned as detached conflict data', () => {
  const input = defaults();
  input.workflowsCurrent = { scripts: { logs: { command: 'project-owned' } } };
  const result = planManifests(input);
  assert.deepEqual(result.workflows.scripts.logs, { command: 'project-owned' });
  const conflict = result.conflicts.find(item => item.script === 'logs');
  assert.deepEqual(conflict.current, { command: 'project-owned' });
  conflict.current.command = 'changed report';
  assert.equal(input.workflowsCurrent.scripts.logs.command, 'project-owned');
});
