import { createServerFn } from "@tanstack/react-start";
import type { DownloadPart, ExportKind } from "../governance/operation-state.ts";
import type { RetentionPatch } from "../governance/retention-state.ts";
import { oneOf } from "../observability/range.ts";
import {
  mintExportDownload,
  replaceEgressAllowlist,
  requestErasure,
  requestExport,
  updateRetentionPolicy,
} from "../server/governance-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { exportKindInput } from "./governance-queries.ts";
import {
  fields,
  keyedInputAt,
  requireBody,
  requireIds,
  type KeyedInputAt,
} from "./server-input.ts";

const DOWNLOAD_PARTS = ["output", "archive"] as const satisfies readonly DownloadPart[];

export const updateRetentionPolicyFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInputAt<"organization"> & {
        readonly body: RetentionPatch;
        readonly expectedVersion: number;
      },
    ) => {
      const { expectedVersion } = fields(input);
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw new TypeError("expectedVersion must be a non-negative integer.");
      }
      return { ...keyedInputAt("organization", input), body: requireBody(input), expectedVersion };
    },
  )
  .handler(async ({ data }) =>
    updateRetentionPolicy({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const replaceEgressAllowlistFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization"> & { readonly body: unknown }) => ({
    ...keyedInputAt("organization", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    replaceEgressAllowlist({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const requestExportFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization"> & { readonly kind: ExportKind }) => ({
    ...keyedInputAt("organization", input),
    kind: exportKindInput(input),
  }))
  .handler(async ({ data }) =>
    requestExport({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const requestErasureFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization">) => keyedInputAt("organization", input))
  .handler(async ({ data }) =>
    requestErasure({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

/** A POST so no cache or prefetch ever replays it: each call mints a URL good for 300 s. */
export const mintExportDownloadFn = createServerFn({ method: "POST" })
  .validator(
    (input: {
      readonly kind: ExportKind;
      readonly operationId: string;
      readonly organizationId: string;
      readonly part: DownloadPart;
    }) => {
      const part = oneOf(DOWNLOAD_PARTS, fields(input).part);
      if (!part) throw new TypeError("part must be output or archive.");
      return {
        ...requireIds(input, ["operationId", "organizationId"]),
        kind: exportKindInput(input),
        part,
      };
    },
  )
  .handler(async ({ data }) =>
    mintExportDownload({ ...data, accessToken: await requireAccessToken() }),
  );
