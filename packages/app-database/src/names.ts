import { Schema } from "effect";

export const AppId = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/u, {
      message: "App ids are 26-character ULIDs in canonical uppercase Crockford base32.",
    }),
  ),
  Schema.brand("AppId"),
);
export type AppId = typeof AppId.Type;

export const AppSlug = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      if (!/^[a-z][a-z0-9-]{1,33}[a-z0-9]$/u.test(input)) {
        return "App slugs have 3 to 35 lowercase letters, digits, or hyphens, start with a letter, and end with a letter or digit.";
      }
      if (input.includes("--")) return "App slugs must not contain consecutive hyphens.";
      return input.startsWith("xn-") ? "App slugs must not start with xn-." : undefined;
    }),
  ),
  Schema.brand("AppSlug"),
);
export type AppSlug = typeof AppSlug.Type;

export const APP_ROLES = ["owner", "editor", "viewer", "visitor"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export type ApiCallerRole = Exclude<AppRole, "owner">;

export const APP_SCHEMAS = ["public", "api", "visitor"] as const;
export const CALLABLE_SCHEMAS = ["api", "visitor"] as const satisfies readonly AppSchema[];
export type AppSchema = (typeof APP_SCHEMAS)[number];
export type CallableSchema = (typeof CALLABLE_SCHEMAS)[number];

export const PgName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-z_][a-z0-9_]*$/u, {
      message:
        "Postgres names here are lowercase letters, digits, and underscores, so they never need quoting.",
    }),
  ),
  Schema.brand("PgName"),
);
export type PgName = typeof PgName.Type;

const pgName = Schema.decodeSync(PgName);

export const PROVISIONER_ROLE = pgName("platform_provisioner");
export const TEMPLATE_DATABASE = pgName("app_template");
export const MAINTENANCE_DATABASE = pgName("postgres");

export interface AppDatabaseNames {
  readonly database: PgName;
  readonly roles: Readonly<Record<AppRole, PgName>>;
}

export function appDatabaseNames(appId: AppId): AppDatabaseNames {
  const base = `app_${appId.toLowerCase()}`;
  return {
    database: pgName(base),
    roles: {
      editor: pgName(`${base}_editor`),
      owner: pgName(`${base}_owner`),
      viewer: pgName(`${base}_viewer`),
      visitor: pgName(`${base}_visitor`),
    },
  };
}

export function appRoleList(names: AppDatabaseNames): readonly PgName[] {
  return APP_ROLES.map((role) => names.roles[role]);
}
