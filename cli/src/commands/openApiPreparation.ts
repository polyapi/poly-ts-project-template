type Document = Record<string, any>;
const methods = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/** Select original operation IDs, then retain the complete local reference closure. */
export function selectOperations(input: Document, ids: string[]): Document {
  const document: Document = JSON.parse(JSON.stringify(input));
  if (!ids.length) return document;
  const requested = new Set(ids);
  const matches = new Map<string, number>();
  const paths: Document = {};
  for (const [route, item] of Object.entries(document.paths ?? {}) as [
    string,
    Document,
  ][]) {
    const selected: Document = {};
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method) || !requested.has(operation?.operationId))
        continue;
      matches.set(
        operation.operationId,
        (matches.get(operation.operationId) ?? 0) + 1
      );
      selected[method] = operation;
    }
    if (Object.keys(selected).length) {
      for (const [key, value] of Object.entries(item))
        if (!methods.has(key)) selected[key] = value;
      paths[route] = selected;
    }
  }
  for (const id of requested) {
    if (matches.get(id) !== 1)
      throw new Error(
        `Operation ID ${id} must match exactly once (found ${matches.get(id) ?? 0}).`
      );
  }
  document.paths = paths;
  // OAS 3.1 webhooks are independent operations, outside the requested selection.
  delete document.webhooks;
  const groups = document.components
    ? Object.fromEntries(
        Object.entries(document.components).map(([key, value]) => [
          `components/${key}`,
          value,
        ])
      )
    : Object.fromEntries(
        ['definitions', 'parameters', 'responses', 'securityDefinitions'].map(
          key => [key, document[key]]
        )
      );
  const retained = new Set<string>();
  const visit = (value: any, map = false): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') {
      if (!value.$ref.startsWith('#/'))
        throw new Error(
          'Operation selection requires bundled local references; bundle external $ref files first.'
        );
      const pointer = value.$ref;
      if (!retained.has(pointer)) {
        retained.add(pointer);
        const parts = pointer
          .slice(2)
          .split('/')
          .map((part: string) =>
            decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')
          );
        const target = parts.reduce(
          (node: any, part: string) => node?.[part],
          document
        );
        if (target === undefined)
          throw new Error(`Unresolved OpenAPI reference: ${pointer}`);
        visit(target);
      }
    }
    const mapping = value.discriminator?.mapping;
    if (mapping && typeof mapping === 'object') {
      for (const target of Object.values(mapping)) {
        if (typeof target !== 'string') continue;
        visit({
          $ref: target.startsWith('#/')
            ? target
            : `#/components/schemas/${target}`,
        });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        !map &&
        ['example', 'default', 'enum', 'const', 'value'].includes(key)
      )
        continue;
      visit(
        child,
        !map && ['properties', 'patternProperties', 'examples'].includes(key)
      );
    }
  };
  visit(paths);
  // Security requirements refer to names, rather than using $ref.
  const securityGroup = document.components
    ? 'components/securitySchemes'
    : 'securityDefinitions';
  for (const name of Object.keys(groups[securityGroup] ?? {})) {
    retained.add(`#/${securityGroup}/${name}`);
    visit(groups[securityGroup][name]);
  }
  for (const [group, entries] of Object.entries(groups) as [
    string,
    Document,
  ][]) {
    if (!entries || typeof entries !== 'object') continue;
    const keep = Object.fromEntries(
      Object.entries(entries).filter(([name]) => {
        const escaped = name.replace(/~/g, '~0').replace(/\//g, '~1');
        const prefix = `#/${group}/${escaped}`;
        return [...retained].some(
          ref => ref === prefix || ref.startsWith(`${prefix}/`)
        );
      })
    );
    if (group.startsWith('components/'))
      document.components[group.slice(11)] = keep;
    else document[group] = keep;
  }
  return document;
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  bull: '•',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  ensp: ' ',
  emsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};
const block = new Set([
  'p',
  'div',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'section',
  'address',
  'article',
  'aside',
  'caption',
  'dd',
  'details',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'header',
  'main',
  'nav',
  'summary',
]);
const html = new Set([
  ...block,
  'a',
  'abbr',
  'b',
  'body',
  'code',
  'dd',
  'dl',
  'dt',
  'em',
  'font',
  'html',
  'i',
  'img',
  'label',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'td',
  'th',
  'thead',
  'tbody',
  'u',
  's',
  'strike',
  'area',
  'audio',
  'base',
  'bdi',
  'bdo',
  'button',
  'canvas',
  'cite',
  'col',
  'colgroup',
  'data',
  'datalist',
  'del',
  'dfn',
  'dialog',
  'embed',
  'fieldset',
  'form',
  'g',
  'head',
  'hgroup',
  'iframe',
  'input',
  'ins',
  'kbd',
  'legend',
  'link',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'noscript',
  'object',
  'optgroup',
  'option',
  'output',
  'path',
  'picture',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  'samp',
  'search',
  'select',
  'slot',
  'source',
  'svg',
  'template',
  'textarea',
  'tfoot',
  'time',
  'title',
  'track',
  'var',
  'video',
  'wbr',
]);

/** Convert recognized HTML markup to text; preserve literal type/placeholders. */
export function descriptionText(text: string): string {
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<\/?([a-z][a-z0-9]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
      (tag, name: string) => {
        name = name.toLowerCase();
        if (!html.has(name)) return tag;
        if (name === 'li' && !tag.startsWith('</')) return '\n- ';
        if (name === 'li') return '';
        return block.has(name)
          ? '\n'
          : name === 'td' || name === 'th'
            ? ' '
            : '';
      }
    )
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      if (!name.startsWith('#')) return entities[name] ?? entity;
      const code =
        name[1].toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '�';
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Clean metadata only; never rewrite source requests, defaults or example payloads. */
export function cleanDescriptions<T>(input: T): T {
  const value = JSON.parse(JSON.stringify(input));
  const visit = (node: any, map = false): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (
        !map &&
        ['source', 'example', 'examples', 'default', 'enum', 'const'].includes(
          key
        )
      )
        continue;
      if (!map && key === 'description' && typeof child === 'string')
        node[key] = descriptionText(child);
      else
        visit(
          child,
          !map &&
            [
              'properties',
              'definitions',
              'schemas',
              'patternProperties',
            ].includes(key)
        );
    }
  };
  visit(value);
  return value;
}
