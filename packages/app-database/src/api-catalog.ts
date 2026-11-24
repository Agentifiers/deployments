import { Schema } from "effect";
import type pg from "pg";
import { CALLABLE_SCHEMAS, type CallableSchema } from "./names.ts";

export interface PgType {
  readonly sql: string;
  readonly base: {
    readonly name: string;
    readonly kind: string;
    readonly element: { readonly name: string; readonly kind: string } | null;
  };
}

export interface ApiArgument {
  readonly name: string;
  readonly type: PgType;
  readonly hasDefault: boolean;
}

export interface ApiColumn {
  readonly name: string;
  readonly type: PgType;
}

export type ApiResult =
  | { readonly kind: "void" }
  | { readonly kind: "scalar"; readonly type: PgType }
  | { readonly kind: "row"; readonly columns: readonly ApiColumn[] }
  | { readonly kind: "record" };

export type ApiVolatility = "immutable" | "stable" | "volatile";

export interface ApiFunction {
  readonly schema: CallableSchema;
  readonly name: string;
  readonly volatility: ApiVolatility;
  readonly returnsSet: boolean;
  readonly arguments: readonly ApiArgument[];
  readonly result: ApiResult;
}

const CatalogPayload = Schema.Struct({
  arguments: Schema.Array(
    Schema.Struct({
      functionOid: Schema.Number,
      mode: Schema.String,
      name: Schema.String,
      type: Schema.Number,
    }),
  ),
  functions: Schema.Array(
    Schema.Struct({
      defaultCount: Schema.Number,
      inputCount: Schema.Number,
      name: Schema.String,
      oid: Schema.Number,
      returnType: Schema.Number,
      returnsSet: Schema.Boolean,
      schema: Schema.Literals(CALLABLE_SCHEMAS),
      volatility: Schema.Literals(["i", "s", "v"]),
    }),
  ),
  returnColumns: Schema.Array(
    Schema.Struct({ functionOid: Schema.Number, name: Schema.String, type: Schema.Number }),
  ),
  types: Schema.Array(
    Schema.Struct({
      elementKind: Schema.NullOr(Schema.String),
      elementName: Schema.NullOr(Schema.String),
      kind: Schema.String,
      name: Schema.String,
      oid: Schema.Number,
      sql: Schema.String,
    }),
  ),
});
type CatalogPayload = typeof CatalogPayload.Type;

const API_CATALOG_SQL = `WITH api_functions AS (
  SELECT p.oid, n.nspname, p.proname, p.provolatile, p.proretset, p.prorettype, p.pronargs, p.pronargdefaults,
    coalesce(p.proallargtypes, p.proargtypes::oid[]) AS arg_types, p.proargmodes, p.proargnames
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = ANY($1::text[]) AND p.prokind = 'f'
), arguments AS (
  SELECT f.oid AS function_oid, a.ord, a.type, coalesce(a.mode, 'i') AS mode, coalesce(a.name, '') AS name
  FROM api_functions f,
    unnest(f.arg_types, f.proargmodes, f.proargnames) WITH ORDINALITY AS a(type, mode, name, ord)
), return_columns AS (
  SELECT f.oid AS function_oid, att.attnum, att.attname, att.atttypid
  FROM api_functions f
  JOIN pg_type t ON t.oid = f.prorettype AND t.typrelid <> 0
  JOIN pg_attribute att ON att.attrelid = t.typrelid AND att.attnum > 0 AND NOT att.attisdropped
), used_types AS (
  SELECT type AS oid FROM arguments
  UNION SELECT prorettype FROM api_functions
  UNION SELECT atttypid FROM return_columns
), type_info AS (
  SELECT u.oid, format_type(u.oid, NULL) AS sql, r.typname AS name, r.typtype AS kind,
    e.typname AS element_name, e.typtype AS element_kind
  FROM used_types u
  JOIN pg_type t ON t.oid = u.oid
  JOIN pg_type r ON r.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
  LEFT JOIN pg_type e ON e.oid = r.typelem AND r.typcategory = 'A'
)
SELECT json_build_object(
  'functions', (SELECT coalesce(json_agg(json_build_object(
    'oid', oid::int8, 'schema', nspname, 'name', proname, 'volatility', provolatile, 'returnsSet', proretset,
    'returnType', prorettype::int8, 'inputCount', pronargs, 'defaultCount', pronargdefaults
  ) ORDER BY proname), '[]'::json) FROM api_functions),
  'arguments', (SELECT coalesce(json_agg(json_build_object(
    'functionOid', function_oid::int8, 'type', type::int8, 'mode', mode, 'name', name
  ) ORDER BY function_oid, ord), '[]'::json) FROM arguments),
  'returnColumns', (SELECT coalesce(json_agg(json_build_object(
    'functionOid', function_oid::int8, 'name', attname, 'type', atttypid::int8
  ) ORDER BY function_oid, attnum), '[]'::json) FROM return_columns),
  'types', (SELECT coalesce(json_agg(json_build_object(
    'oid', oid::int8, 'sql', sql, 'name', name, 'kind', kind,
    'elementName', element_name, 'elementKind', element_kind
  )), '[]'::json) FROM type_info)
) AS catalog`;

const VOLATILITY: Readonly<Record<"i" | "s" | "v", ApiVolatility>> = {
  i: "immutable",
  s: "stable",
  v: "volatile",
};
const INPUT_MODES: Readonly<Record<string, true>> = { b: true, i: true, v: true };
const OUTPUT_MODES: Readonly<Record<string, true>> = { b: true, o: true, t: true };

function assemble(payload: CatalogPayload): readonly ApiFunction[] {
  const types = new Map(
    payload.types.map((type) => [
      type.oid,
      {
        base: {
          element:
            type.elementName === null || type.elementKind === null
              ? null
              : { kind: type.elementKind, name: type.elementName },
          kind: type.kind,
          name: type.name,
        },
        sql: type.sql,
      } satisfies PgType,
    ]),
  );
  const typeOf = (oid: number): PgType =>
    types.get(oid) ?? { base: { element: null, kind: "p", name: "unknown" }, sql: "unknown" };
  return payload.functions.map((fn) => {
    const parameters = payload.arguments.filter((argument) => argument.functionOid === fn.oid);
    const inputs = parameters.filter((parameter) => Object.hasOwn(INPUT_MODES, parameter.mode));
    const outputs = parameters.filter((parameter) => Object.hasOwn(OUTPUT_MODES, parameter.mode));
    const returnType = typeOf(fn.returnType);
    const returnColumns = payload.returnColumns.filter((column) => column.functionOid === fn.oid);
    const firstDefault = fn.inputCount - fn.defaultCount;
    let result: ApiResult;
    if (returnType.base.name === "void") result = { kind: "void" };
    else if (outputs.length > 1) {
      result = {
        columns: outputs.map((output) => ({ name: output.name, type: typeOf(output.type) })),
        kind: "row",
      };
    } else if (returnColumns.length > 0) {
      result = {
        columns: returnColumns.map((column) => ({ name: column.name, type: typeOf(column.type) })),
        kind: "row",
      };
    } else if (returnType.base.name === "record") result = { kind: "record" };
    else result = { kind: "scalar", type: returnType };
    return {
      arguments: inputs.map((input, index) => ({
        hasDefault: index >= firstDefault,
        name: input.name,
        type: typeOf(input.type),
      })),
      name: fn.name,
      result,
      returnsSet: fn.returnsSet,
      schema: fn.schema,
      volatility: VOLATILITY[fn.volatility],
    };
  });
}

const decodeCatalog = Schema.decodeUnknownSync(CatalogPayload);

export async function loadApiCatalog(client: pg.ClientBase): Promise<readonly ApiFunction[]> {
  const result = await client.query<{ catalog: unknown }>(API_CATALOG_SQL, [CALLABLE_SCHEMAS]);
  return assemble(decodeCatalog(result.rows[0]?.catalog));
}
