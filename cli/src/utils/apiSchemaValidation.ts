import fs from 'node:fs';
import path from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import { chalk, logger, warningColor } from './logger';

type EndpointSchemaName =
  | 'CreateApiFunctionDto'
  | 'CreateSchemaDto'
  | 'UpdateSchemaDto'
  | 'CreateWebhookHandleDto'
  | 'UpdateWebhookHandleDto'
  | 'CreateTriggerDto'
  | 'GraphQLSubscriptionCreateDto'
  | 'GraphQLSubscriptionUpdateDto'
  | 'CreateVariableDto'
  | 'UpdateVariableDto'
  | 'CreateTableDto'
  | 'UpdateTableDto'
  | 'CreateJobDto'
  | 'UpdateJobDto'
  | 'CreateServerCustomFunctionDto'
  | 'CreateClientCustomFunctionDto'
  | 'CreateAiFunctionV2Dto'
  | 'UpdateAiFunctionV2Dto';

type ValidationContext = {
  artifactType: string;
  artifactName: string;
  filePath?: string;
};

const validatorCache = new Map<EndpointSchemaName, ValidateFunction>();
const ajv = new Ajv({
  allErrors: true,
  strict: false,
});

function getEndpointSchemaPath(schemaName: EndpointSchemaName): string {
  return path.join(
    __dirname,
    '..',
    '..',
    'schemas',
    'openapi',
    `${schemaName}.schema.json`
  );
}

function loadValidator(
  schemaName: EndpointSchemaName
): ValidateFunction | null {
  const cachedValidator = validatorCache.get(schemaName);
  if (cachedValidator) {
    return cachedValidator;
  }

  const schemaPath = getEndpointSchemaPath(schemaName);
  if (!fs.existsSync(schemaPath)) {
    logger.warn(
      warningColor(
        `Schema file not found for ${schemaName} at ${schemaPath}. Run \`pnpm --filter flow-cli run generate\`.`
      )
    );
    return null;
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const validator = ajv.compile(schema);
  validatorCache.set(schemaName, validator);
  return validator;
}

export function validateEndpointPayload(
  schemaName: EndpointSchemaName,
  payload: unknown,
  context: ValidationContext
): boolean {
  const validator = loadValidator(schemaName);
  if (!validator) {
    return true;
  }

  const valid = validator(payload);
  if (valid) {
    return true;
  }

  logger.error(
    chalk.red.bold('⚠️  OPENAPI PAYLOAD VALIDATION FAILED') +
      chalk.gray(
        ` (${context.artifactType}: ${context.artifactName}, schema: ${schemaName})`
      )
  );
  if (context.filePath) {
    logger.error(chalk.cyan(`  File: ${context.filePath}`));
  }

  for (const error of validator.errors ?? []) {
    const errorPath = error.instancePath || '(root)';
    logger.error(warningColor(`  → ${errorPath}: ${error.message}`));
  }

  return false;
}
