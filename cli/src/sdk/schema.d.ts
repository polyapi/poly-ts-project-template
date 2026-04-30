/**
 * Minimal PolyAPI SDK type surface for the template Flow CLI.
 *
 * `pnpm --filter flow-cli run generate` can replace this with the full
 * openapi-typescript output generated from the active PolyAPI instance.
 */

export type components = {
  schemas: {
    SchemaDto: any;
    SchemaDetailsDto: any;
    WebhookHandleBasicDto: any;
    WebhookHandleDto: any;
    WebhookSecurityFunction: any;
    VariableDto: any;
    TableResponseDto: any;
    TableColumnDto: any;
    PaginationDto: any;
  };
};

export type paths = any;
