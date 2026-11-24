import {
  ApiCredentialResponse,
  IssuedApiCredentialResponse,
} from "@deployments-ai/api-contract/tenancy";
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { shownOnceKey } from "./api-key-actions.ts";

test("an issued key's view carries no secret", () => {
  const key = {
    createdAt: "2026-10-05T12:00:00.000Z",
    environmentId: "01K0000000000000000000000E",
    id: "01K0000000000000000000K001",
    keyPrefix: "dpl_live_abcdefg",
    name: "billing backend",
    organizationId: "01K0000000000000000000000A",
    projectId: "01K0000000000000000000000B",
    scopes: ["runs:read"],
    serviceAccountId: "01K00000000000000000000SA1",
    status: "active",
    updatedAt: "2026-10-05T12:00:00.000Z",
    version: 1,
  };
  const issued = Schema.decodeUnknownSync(IssuedApiCredentialResponse)({
    ...key,
    secret: "dpl_live_abcdefg_secret",
    secretVisibleOnce: true,
  });
  expect(shownOnceKey(issued)).toStrictEqual({
    secret: "dpl_live_abcdefg_secret",
    view: Schema.decodeUnknownSync(ApiCredentialResponse)(key),
  });
});
