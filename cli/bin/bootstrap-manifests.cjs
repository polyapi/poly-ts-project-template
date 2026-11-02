// Add only missing Flow launchers. Existing project settings and scripts remain
// owned by the project, including scripts that conflict with template defaults.
const ROOT_SCRIPTS = ['flow', 'workflows'];
const WORKFLOW_SCRIPTS = [
  'push',
  'push:dry-run',
  'train-openapi',
  'train-model',
  'delete-content',
  'logs',
  'train:openapi',
  'delete:content',
];

function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    // fromEntries creates own data properties, including __proto__, rather than
    // invoking Object.prototype setters during cloning.
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child)])
    );
  }
  return value;
}

function validateManifest(manifest, label) {
  requireObject(manifest, label);
  if (hasOwn(manifest, 'scripts')) {
    requireObject(manifest.scripts, `${label} scripts`);
  }
}

function planOne(
  current,
  template,
  file,
  allowedScripts,
  additions,
  conflicts
) {
  validateManifest(current, file);
  validateManifest(template, `Template ${file}`);
  const result = cloneJson(current);
  const templateScripts = hasOwn(template, 'scripts') ? template.scripts : {};

  for (const script of allowedScripts) {
    if (!hasOwn(templateScripts, script)) continue;
    const value = templateScripts[script];
    if (typeof value !== 'string') {
      throw new TypeError(
        `Template ${file} scripts.${script} must be a string.`
      );
    }

    if (!hasOwn(result, 'scripts')) result.scripts = {};
    if (hasOwn(result.scripts, script)) {
      if (result.scripts[script] !== value) {
        conflicts.push({
          file,
          script,
          current: result.scripts[script],
          template: value,
        });
      }
    } else {
      result.scripts[script] = value;
      additions.push({ file, script, value });
    }
  }
  return result;
}

function planManifests({
  rootCurrent,
  workflowsCurrent,
  rootTemplate,
  workflowsTemplate,
}) {
  const additions = [];
  const conflicts = [];
  const root = planOne(
    rootCurrent,
    rootTemplate,
    'package.json',
    ROOT_SCRIPTS,
    additions,
    conflicts
  );
  const workflows = planOne(
    workflowsCurrent,
    workflowsTemplate,
    'workflows/package.json',
    WORKFLOW_SCRIPTS,
    additions,
    conflicts
  );
  return { root, workflows, additions, conflicts };
}

module.exports = { planManifests };
