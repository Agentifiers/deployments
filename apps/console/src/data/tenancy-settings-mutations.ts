import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  archiveTenancyResource,
  updateTenancyResource,
} from "../server/tenancy-settings-actions.ts";
import type { ArchivableLevel, GeneralChanges, TenancyRef } from "../tenancy/settings.ts";
import { fields, requireIdempotencyKey } from "./server-input.ts";
import { tenancyRefInput } from "./tenancy-settings-queries.ts";

const CHANGE_FIELDS = ["description", "name", "slug"] as const;

/** Keeps only the fields an update may name; the action decodes their values. */
function changesInput(input: unknown): GeneralChanges {
  const body = fields(fields(input).body);
  const changes = Object.fromEntries(
    CHANGE_FIELDS.filter((field) => body[field] !== undefined).map((field) => [field, body[field]]),
  );
  if (Object.keys(changes).length === 0) throw new TypeError("body must change one field.");
  return changes as GeneralChanges;
}

function expectedVersionInput(input: unknown): number {
  const { expectedVersion } = fields(input);
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw new TypeError("expectedVersion must be a positive integer.");
  }
  return expectedVersion;
}

export const updateTenancyResourceFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly body: GeneralChanges;
      readonly expectedVersion: number;
      readonly idempotencyKey: string;
      readonly ref: TenancyRef;
    }) => ({
      body: changesInput(input),
      expectedVersion: expectedVersionInput(input),
      idempotencyKey: requireIdempotencyKey(input),
      ref: tenancyRefInput(input),
    }),
  )
  .handler(async ({ data }) =>
    updateTenancyResource({ ...data, accessToken: await requireAccessToken() }),
  );

type ArchivableRef = Extract<TenancyRef, { readonly level: ArchivableLevel }>;

export const archiveTenancyResourceFn = createServerFn({ method: "POST" })
  .validator((input: { readonly idempotencyKey: string; readonly ref: ArchivableRef }) => {
    const ref = tenancyRefInput(input);
    if (ref.level === "organization") throw new TypeError("Organizations cannot be archived.");
    return { idempotencyKey: requireIdempotencyKey(input), ref };
  })
  .handler(async ({ data }) =>
    archiveTenancyResource({ ...data, accessToken: await requireAccessToken() }),
  );
