import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AppId, appDatabaseNames } from "./names.ts";
import { provisionViolations, type ProvisionObservation } from "./provision-check.ts";

const names = appDatabaseNames(Schema.decodeUnknownSync(AppId)("01J9Z3NDEKTSV4RRFFQ69G5FAV"));
const roles = [names.roles.owner, names.roles.editor, names.roles.viewer, names.roles.visitor];

const provisioned: ProvisionObservation = {
  aclIsDefault: false,
  databaseAcl: [
    { grantee: "platform_provisioner", privilege: "CREATE" },
    { grantee: "platform_provisioner", privilege: "TEMPORARY" },
    { grantee: "platform_provisioner", privilege: "CONNECT" },
    ...roles.map((grantee) => ({ grantee, privilege: "CONNECT" })),
  ],
  iamMembers: roles.toSorted(),
  iamRolePresent: true,
  schemaOwners: {
    api: names.roles.owner,
    platform: "platform_provisioner",
    public: names.roles.owner,
    visitor: names.roles.owner,
  },
};

describe("provisionViolations", () => {
  test("accepts the provisioned layout", () => {
    expect(provisionViolations(provisioned, names)).toEqual([]);
  });

  test("names every drift from the provisioned layout", () => {
    const drifted: ProvisionObservation = {
      aclIsDefault: true,
      databaseAcl: [
        { grantee: "PUBLIC", privilege: "CONNECT" },
        { grantee: names.roles.owner, privilege: "CONNECT" },
      ],
      iamMembers: [names.roles.owner],
      iamRolePresent: true,
      schemaOwners: { public: "platform_provisioner" },
    };
    expect(provisionViolations(drifted, names)).toEqual([
      "Database app_01j9z3ndektsv4rrffq69g5fav has the default ACL, so PUBLIC may connect.",
      "PUBLIC holds CONNECT on database app_01j9z3ndektsv4rrffq69g5fav.",
      "CONNECT on app_01j9z3ndektsv4rrffq69g5fav is granted to [PUBLIC, app_01j9z3ndektsv4rrffq69g5fav_owner], expected [app_01j9z3ndektsv4rrffq69g5fav_editor, app_01j9z3ndektsv4rrffq69g5fav_owner, app_01j9z3ndektsv4rrffq69g5fav_viewer, app_01j9z3ndektsv4rrffq69g5fav_visitor].",
      "rds_iam members among the app roles are [app_01j9z3ndektsv4rrffq69g5fav_owner], expected [app_01j9z3ndektsv4rrffq69g5fav_editor, app_01j9z3ndektsv4rrffq69g5fav_owner, app_01j9z3ndektsv4rrffq69g5fav_viewer, app_01j9z3ndektsv4rrffq69g5fav_visitor].",
      "Schema api is owned by nobody, expected app_01j9z3ndektsv4rrffq69g5fav_owner.",
      "Schema platform is owned by nobody, expected platform_provisioner.",
      "Schema public is owned by platform_provisioner, expected app_01j9z3ndektsv4rrffq69g5fav_owner.",
      "Schema visitor is owned by nobody, expected app_01j9z3ndektsv4rrffq69g5fav_owner.",
    ]);
  });

  test("skips the IAM membership check where rds_iam does not exist", () => {
    expect(
      provisionViolations({ ...provisioned, iamMembers: [], iamRolePresent: false }, names),
    ).toEqual([]);
  });
});
