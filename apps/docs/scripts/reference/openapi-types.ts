export type JsonSchema = { readonly [keyword: string]: unknown };

export interface OpenApiParameter {
  readonly in: string;
  readonly name: string;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
}

export interface CodeSample {
  readonly lang: string;
  readonly label: string;
  readonly source: string;
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly content: { readonly [mediaType: string]: { readonly schema: JsonSchema } };
  };
  readonly "x-codeSamples"?: readonly CodeSample[];
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string };
  readonly servers?: readonly { readonly url: string }[];
  readonly paths: { readonly [path: string]: { readonly [method: string]: OpenApiOperation } };
  readonly components: {
    readonly schemas: { readonly [name: string]: JsonSchema };
    readonly securitySchemes: { readonly [name: string]: JsonSchema };
  };
  readonly tags?: readonly { readonly name: string }[];
}
