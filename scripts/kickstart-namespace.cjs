const fs = require('node:fs');
const path = require('node:path');
const projectRoot = path.resolve(process.argv[3] || process.cwd());
const namespace = process.argv[2];
if (
  !namespace ||
  !/^[A-Za-z0-9_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/.test(
    namespace
  )
) {
  throw new Error(
    'Provide a project namespace using letters, numbers, underscores, hyphens and dot-separated segments.'
  );
}
const ts = require(path.join(projectRoot, 'workflows/node_modules/typescript'));
const segments = namespace.split('.');
const propertyName = value =>
  /^[A-Za-z_$][\w$]*$/.test(value) ? value : JSON.stringify(value);
const access = segments
  .map(value =>
    /^[A-Za-z_$][\w$]*$/.test(value)
      ? '.' + value
      : '[' + JSON.stringify(value) + ']'
  )
  .join('');

function isPolyMock(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      parent.expression.getText() === 'mockModule' &&
      parent.arguments[0]?.text === 'polyapi'
    )
      return true;
  }
  return false;
}

function rewrite(file) {
  const original = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    original,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS
  );
  const edits = [];
  const edit = (start, end, text) => edits.push({ start, end, text });
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.text;
      const value = node.initializer;
      if (
        typeof key === 'string' &&
        /context$/i.test(key) &&
        (ts.isStringLiteral(value) ||
          ts.isNoSubstitutionTemplateLiteral(value)) &&
        value.text.startsWith('example.')
      ) {
        edit(
          value.getStart(source) + 1,
          value.end - 1,
          namespace + value.text.slice('example'.length)
        );
      }
      if (key === 'example' && isPolyMock(node)) {
        edit(
          node.name.getStart(source),
          node.name.end,
          propertyName(segments[0])
        );
        if (segments.length > 1) {
          edit(
            value.getStart(source),
            value.getStart(source),
            segments
              .slice(1)
              .map(part => '{ ' + propertyName(part) + ': ')
              .join('')
          );
          edit(value.end, value.end, ' }'.repeat(segments.length - 1));
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'example' &&
      ts.isIdentifier(node.expression) &&
      ['poly', 'vari'].includes(node.expression.text)
    ) {
      edit(node.getStart(source), node.end, node.expression.text + access);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let updated = original;
  for (const change of edits.sort(
    (a, b) => b.start - a.start || b.end - a.end
  )) {
    updated =
      updated.slice(0, change.start) + change.text + updated.slice(change.end);
  }
  if (updated !== original) fs.writeFileSync(file, updated);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && /\.(json|ts)$/.test(entry.name)) rewrite(file);
  }
}
walk(path.join(projectRoot, 'workflows/src'));
