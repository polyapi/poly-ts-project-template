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

const contextKeys = new Set([
  'context',
  'functionContext',
  'webhookContext',
  'variableContext',
  'systemPromptVariableContext',
  'tableContext',
  'schemaContext',
]);
// These objects describe application data rather than PolyAPI resource identity.
const dataKeys = new Set([
  'properties',
  'example',
  'examples',
  'default',
  'enum',
  'const',
  'value',
  'eventPayload',
  'headersPayload',
  'paramsPayload',
  'body',
  'inputTemplate',
]);

const replaceRoot = value =>
  value === 'example' || value.startsWith('example.')
    ? namespace + value.slice('example'.length)
    : value;

function propertyParents(node) {
  const keys = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent)) keys.push(parent.name.text);
  }
  return keys;
}

function isPolyMockNamespace(node) {
  const container = node.parent.parent;
  if (
    !ts.isPropertyAssignment(container) ||
    !['default', 'vari', 'tabi', 'schemas'].includes(container.name.text)
  )
    return false;
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

function isPolyConfig(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent))
      return parent.name.getText() === 'polyConfig';
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
  const editString = (node, value) => {
    if (value !== node.text)
      edit(node.getStart(source) + 1, node.end - 1, value);
  };
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.text;
      const value = node.initializer;
      const parents = propertyParents(node);
      const isMetadata = !parents.some(name => dataKeys.has(name));
      if (
        isMetadata &&
        (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      ) {
        if (
          contextKeys.has(key) &&
          (file.endsWith('.json') || key !== 'context' || isPolyConfig(node))
        )
          editString(value, replaceRoot(value.text));

        // Webhook security functions use a portable {{context.function}} ID.
        if (key === 'id' && parents.includes('securityFunctions')) {
          const match = /^\{\{(example\.[A-Za-z0-9_.-]+)\}\}$/.exec(value.text);
          if (match) editString(value, `{{${replaceRoot(match[1])}}}`);
        }
        // The common error trigger uses a namespace filter, not an HTTP URL.
        if (key === 'path' && parents.includes('errorHandler')) {
          editString(value, replaceRoot(value.text));
        }
      }
      if (key === 'example' && isPolyMockNamespace(node)) {
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
      ['poly', 'vari', 'tabi', 'schemas'].includes(node.expression.text)
    ) {
      edit(node.getStart(source), node.end, node.expression.text + access);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'example' &&
      ts.isIdentifier(node.expression) &&
      ['poly', 'vari', 'tabi', 'schemas'].includes(node.expression.text)
    )
      edit(node.getStart(source), node.end, node.expression.text + access);
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

function rewriteDocumentedIdentifiers(code) {
  return code
    .replace(
      /(^|[^\w./:\\-])(example(?:\.[A-Za-z_$][\w$-]*)+(?:\.(?:\*|\{file\}))?)(?![\w./\\-])/g,
      (match, prefix, context) => {
        // A filename or domain is not a PolyAPI context.
        if (
          /\.(?:md|json|ya?ml|[cm]?js|tsx?|py|env|com|org|net|io)$/i.test(
            context
          )
        )
          return match;
        return prefix + replaceRoot(context);
      }
    )
    .replace(
      /(^|[^\w./:\\-])(poly|vari|tabi|schemas)(?:\.example|\[['"]example['"]\])(?![\w$-])/g,
      (_match, prefix, sdk) => prefix + sdk + access
    )
    .replace(
      /(\bPOLYAPI_NAMESPACES?\s*=\s*["']?)example(?=$|[.,\s"'])/g,
      (_match, assignment) => assignment + namespace
    );
}

// Personalize executable examples and inline identifiers, not prose or links.
function rewriteDocumentedCode(code, inline = false) {
  if (inline && code.trim() === 'example')
    return code.replace('example', namespace);

  // Query values and fragments can resemble owned contexts or SDK calls too.
  // Keep the entire URL unchanged, not just its host and path.
  return code
    .split(/([a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+)/gi)
    .map((part, index) =>
      index % 2 ? part : rewriteDocumentedIdentifiers(part)
    )
    .join('');
}

function rewriteMarkdown(file) {
  if (!fs.existsSync(file)) return;
  const original = fs.readFileSync(file, 'utf8');
  let fence;
  const updated = original
    .split('\n')
    .map(line => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length)
          fence = undefined;
        return line;
      }
      if (fence) return rewriteDocumentedCode(line);
      return line.replace(
        /(`+)([^`]+)\1/g,
        (_match, ticks, code) =>
          ticks + rewriteDocumentedCode(code, true) + ticks
      );
    })
    .join('\n');
  if (updated !== original) fs.writeFileSync(file, updated);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && /\.(json|ts)$/.test(entry.name)) rewrite(file);
    else if (entry.isFile() && /^(?:README|OVERVIEW)\.md$/.test(entry.name))
      rewriteMarkdown(file);
  }
}
walk(path.join(projectRoot, 'workflows/src'));
for (const file of ['README.md', 'cli/README.md'])
  rewriteMarkdown(path.join(projectRoot, file));
const docs = path.join(projectRoot, 'docs');
if (fs.existsSync(docs)) {
  for (const entry of fs.readdirSync(docs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md'))
      rewriteMarkdown(path.join(docs, entry.name));
  }
}
