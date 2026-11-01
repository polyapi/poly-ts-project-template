import { validateEndpointPayload } from '../utils/apiSchemaValidation';
import { validateNamespace } from '../utils/namespace';
import { cleanDescriptions } from './openApiPreparation';

export type ModelResource = Record<string, any> & {
  name: string;
  context: string;
};
export interface TrainingModel {
  functions: ModelResource[];
  schemas: ModelResource[];
  webhooks: ModelResource[];
}

/** Order dependency layers, treating valid recursive references as strongly connected groups. */
export function schemaLayers(schemas: ModelResource[]): ModelResource[][] {
  const byKey = new Map(
    schemas.map(item => [`${item.context}.${item.name}`, item])
  );
  const references = (node: any): string[] => {
    if (Array.isArray(node)) return node.flatMap(references);
    if (!node || typeof node !== 'object') return [];
    const ref = node['x-poly-ref'];
    return [
      ...(ref && !ref.publicNamespace && typeof ref.path === 'string'
        ? [ref.path]
        : []),
      ...Object.entries(node)
        .filter(
          ([key]) =>
            !['example', 'examples', 'default', 'enum', 'const'].includes(key)
        )
        .flatMap(([, value]) => references(value)),
    ];
  };
  const dependencies = new Map(
    schemas.map(item => {
      const key = `${item.context}.${item.name}`;
      return [
        key,
        [...new Set(references(item.definition))].filter(ref => byKey.has(ref)),
      ] as const;
    })
  );
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const active = new Set<string>();
  const groups: string[][] = [];
  const visit = (key: string): void => {
    const index = indices.size;
    indices.set(key, index);
    low.set(key, index);
    stack.push(key);
    active.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        low.set(
          key,
          Math.min(low.get(key) ?? index, low.get(dependency) ?? index)
        );
      } else if (active.has(dependency))
        low.set(
          key,
          Math.min(low.get(key) ?? index, indices.get(dependency) ?? index)
        );
    }
    if (low.get(key) === index) {
      const group: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (!current) throw new Error('Invalid schema dependency graph.');
        active.delete(current);
        group.push(current);
      } while (current !== key);
      groups.push(group);
    }
  };
  for (const key of byKey.keys()) if (!indices.has(key)) visit(key);
  const membership = new Map(
    groups.flatMap((group, index) => group.map(key => [key, index] as const))
  );
  const pending = new Set(groups.map((_, index) => index));
  const layers: ModelResource[][] = [];
  while (pending.size) {
    const ready = [...pending].filter(index =>
      groups[index].every(key =>
        (dependencies.get(key) ?? []).every(
          ref =>
            membership.get(ref) === index ||
            !pending.has(membership.get(ref) ?? -1)
        )
      )
    );
    if (!ready.length) throw new Error('Invalid schema component graph.');
    layers.push(
      ready.flatMap(index =>
        groups[index].map(key => byKey.get(key) as ModelResource)
      )
    );
    for (const index of ready) pending.delete(index);
  }
  return layers;
}

export function validateModel(value: any): TrainingModel {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['functions', 'schemas', 'webhooks'].some(key => key in value)
  )
    throw new Error(
      'Expected a Poly model with functions, schemas, or webhooks.'
    );
  const model = { functions: [], schemas: [], webhooks: [] } as TrainingModel;
  for (const [kind, schema] of [
    ['functions', 'CreateApiFunctionDto'],
    ['schemas', 'CreateSchemaDto'],
    ['webhooks', 'CreateWebhookHandleDto'],
  ] as const) {
    const items = value[kind] ?? [];
    if (!Array.isArray(items)) throw new Error(`Invalid model ${kind}.`);
    const seen = new Set<string>();
    for (const item of items) {
      if (
        !item ||
        typeof item.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name) ||
        typeof item.context !== 'string'
      )
        throw new Error(`Invalid model identity in ${kind}.`);
      validateNamespace(item.context, kind, item.name);
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(
          item.context
        )
      )
        throw new Error(`Invalid model context: ${item.context}`);
      const identity = `${item.context}.${item.name}`;
      if (seen.has(identity))
        throw new Error(`Duplicate model identity in ${kind}: ${identity}`);
      seen.add(identity);
      if (
        !validateEndpointPayload(schema, item, {
          artifactType: kind,
          artifactName: identity,
        })
      )
        throw new Error(`Invalid ${kind} payload: ${identity}`);
    }
    model[kind] = items;
  }
  if (!Object.values(model).some(items => items.length))
    throw new Error('Generated model contains no trainable resources.');
  schemaLayers(model.schemas);
  return model;
}

export function prepareModel(
  input: unknown,
  renames: string[][]
): TrainingModel {
  let model: any = cleanDescriptions(input);
  for (const [oldName, newName] of renames) {
    if (!oldName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName ?? ''))
      throw new Error('Model renames require FROM and an identifier TO.');
    const pattern = new RegExp(
      `\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'g'
    );
    // Work on string values, so numeric values and JSON syntax cannot be corrupted.
    const rename = (value: any): any =>
      typeof value === 'string'
        ? value.replace(pattern, () => newName)
        : Array.isArray(value)
          ? value.map(rename)
          : value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value).map(([key, child]) => [
                  key,
                  rename(child),
                ])
              )
            : value;
    model = rename(model);
  }
  return validateModel(model);
}
