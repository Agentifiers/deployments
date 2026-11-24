import { describe, expect, test } from "bun:test";
import {
  AccessDenied,
  CNAMEAlreadyExists,
  CloudFrontClient,
  EntityNotFound,
  InvalidArgument,
  InvalidIfMatchVersion,
  PreconditionFailed,
  type DistributionTenant,
  type ServiceOutputTypes,
} from "@aws-sdk/client-cloudfront";
import { cloudFrontEdge } from "./cloudfront-edge.ts";
import type { Tenant } from "./edge.ts";

const DISTRIBUTION_ID = "EDFDVBD6EXAMPLE";

function fakeCloudFront(replies: (ServiceOutputTypes | Error)[]) {
  const sent: Array<{
    readonly command: string | undefined;
    readonly input: unknown;
  }> = [];
  const client = new CloudFrontClient({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    region: "us-east-1",
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      sent.push({ command: context.commandName, input: args.input });
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`No fake reply left for ${context.commandName}.`);
      if (reply instanceof Error) throw reply;
      return { output: reply, response: {} };
    },
    { priority: "high", step: "initialize" },
  );
  return {
    edge: cloudFrontEdge({
      client,
      connectionGroupId: "cg_example",
      distributionId: DISTRIBUTION_ID,
    }),
    sent,
  };
}

const error = <Failure extends Error>(
  Failure: new (options: { $metadata: object; message: string }) => Failure,
) => new Failure({ $metadata: {}, message: "fake" });

const stored = {
  Arn: "arn:aws:cloudfront::111122223333:distribution-tenant/dt_1",
  ConnectionGroupId: "cg_example",
  CreatedTime: new Date("2026-03-01T00:00:00.000Z"),
  Customizations: { GeoRestrictions: { Locations: ["US"], RestrictionType: "whitelist" } },
  DistributionId: DISTRIBUTION_ID,
  Domains: [{ Domain: "www.example.com", Status: "active" }],
  Enabled: true,
  LastModifiedTime: new Date("2026-03-01T00:00:00.000Z"),
  Id: "dt_1",
  Name: "app-domain-01J00000000000000000000000",
  Parameters: [{ Name: "appId", Value: "01J00000000000000000000001" }],
  Status: "Deployed",
} satisfies DistributionTenant;

const seen: Tenant = {
  arn: "arn:aws:cloudfront::111122223333:distribution-tenant/dt_1",
  certificateArn: undefined,
  deployed: true,
  domainActive: true,
  enabled: true,
  etag: "E1",
  hostname: "www.example.com",
  id: "dt_1",
  name: "app-domain-01J00000000000000000000000",
  onDistribution: true,
};

const unchanged = {
  ConnectionGroupId: "cg_example",
  Customizations: { GeoRestrictions: { Locations: ["US"], RestrictionType: "whitelist" } },
  DistributionId: DISTRIBUTION_ID,
  Domains: [{ Domain: "www.example.com" }],
  Enabled: true,
  Id: "dt_1",
  IfMatch: "E1",
  Parameters: [{ Name: "appId", Value: "01J00000000000000000000001" }],
};

describe("cloudFrontEdge", () => {
  test("attaches a certificate with the observed ETag, keeping every other tenant setting", async () => {
    const cloudFront = fakeCloudFront([
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      { $metadata: {} },
    ]);

    expect(
      await cloudFront.edge.attachCertificate(seen, "arn:aws:acm:us-east-1:1:certificate/c"),
    ).toBe("applied");
    expect(cloudFront.sent).toEqual([
      { command: "GetDistributionTenantCommand", input: { Identifier: "dt_1" } },
      {
        command: "UpdateDistributionTenantCommand",
        input: {
          ...unchanged,
          Customizations: {
            Certificate: { Arn: "arn:aws:acm:us-east-1:1:certificate/c" },
            GeoRestrictions: { Locations: ["US"], RestrictionType: "whitelist" },
          },
        },
      },
    ]);
  });

  test("disables with Enabled false, and a certificate request keeps a disabled tenant disabled", async () => {
    const cloudFront = fakeCloudFront([
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      { $metadata: {} },
      { $metadata: {}, DistributionTenant: { ...stored, Enabled: false }, ETag: "E1" },
      { $metadata: {} },
    ]);

    await cloudFront.edge.disable(seen);
    await cloudFront.edge.requestCertificate(seen);

    expect(
      cloudFront.sent.filter((call) => call.command === "UpdateDistributionTenantCommand"),
    ).toEqual([
      { command: "UpdateDistributionTenantCommand", input: { ...unchanged, Enabled: false } },
      {
        command: "UpdateDistributionTenantCommand",
        input: {
          ...unchanged,
          Enabled: false,
          ManagedCertificateRequest: {
            PrimaryDomainName: "www.example.com",
            ValidationTokenHost: "cloudfront",
          },
        },
      },
    ]);
  });

  test("reports a write as stale when the tenant changed, vanished, or lost the ETag race", async () => {
    const changed = fakeCloudFront([{ $metadata: {}, DistributionTenant: stored, ETag: "E2" }]);
    expect(await changed.edge.disable(seen)).toBe("stale");
    expect(changed.sent.map((call) => call.command)).toEqual(["GetDistributionTenantCommand"]);

    const vanished = fakeCloudFront([error(EntityNotFound)]);
    expect(await vanished.edge.disable(seen)).toBe("stale");

    const raced = fakeCloudFront([
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      error(PreconditionFailed),
    ]);
    expect(await raced.edge.disable(seen)).toBe("stale");

    const denied = fakeCloudFront([
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      error(AccessDenied),
    ]);
    expect(await denied.edge.disable(seen).catch((failure: unknown) => failure)).toBeInstanceOf(
      AccessDenied,
    );
  });

  test("deletes with the observed ETag and treats a moved ETag as stale", async () => {
    const cloudFront = fakeCloudFront([{ $metadata: {} }, error(InvalidIfMatchVersion)]);

    expect(await cloudFront.edge.delete(seen)).toBe("applied");
    expect(await cloudFront.edge.delete(seen)).toBe("stale");
    expect(cloudFront.sent).toEqual([
      { command: "DeleteDistributionTenantCommand", input: { Id: "dt_1", IfMatch: "E1" } },
      { command: "DeleteDistributionTenantCommand", input: { Id: "dt_1", IfMatch: "E1" } },
    ]);
  });

  test("lists every page of the account's tenants and marks the ones on other distributions", async () => {
    const cloudFront = fakeCloudFront([
      {
        $metadata: {},
        DistributionTenantList: [{ ...stored, ETag: "E1" }],
        NextMarker: "page-2",
      },
      {
        $metadata: {},
        DistributionTenantList: [
          {
            ...stored,
            Arn: "arn:aws:cloudfront::111122223333:distribution-tenant/dt_2",
            DistributionId: "EOTHER",
            Domains: [{ Domain: "shop.example.com", Status: "inactive" }],
            Enabled: false,
            ETag: "E7",
            Id: "dt_2",
            Name: "brochure",
            Status: "InProgress",
          },
        ],
      },
    ]);

    expect(await cloudFront.edge.list()).toEqual([
      seen,
      {
        arn: "arn:aws:cloudfront::111122223333:distribution-tenant/dt_2",
        certificateArn: undefined,
        deployed: false,
        domainActive: false,
        enabled: false,
        etag: "E7",
        hostname: "shop.example.com",
        id: "dt_2",
        name: "brochure",
        onDistribution: false,
      },
    ]);
    expect(cloudFront.sent.map((call) => call.input)).toEqual([{}, { Marker: "page-2" }]);
  });

  test("finds a tenant by name only on its own distribution", async () => {
    const cloudFront = fakeCloudFront([
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      { $metadata: {}, DistributionTenant: { ...stored, DistributionId: "EOTHER" }, ETag: "E1" },
      error(EntityNotFound),
    ]);

    expect(await cloudFront.edge.get(seen.name)).toEqual(seen);
    expect(await cloudFront.edge.get(seen.name)).toBeUndefined();
    expect(await cloudFront.edge.get(seen.name)).toBeUndefined();
  });

  test("creates a tagged tenant with a managed certificate request, and tells a lost race, a taken hostname, and a rejected hostname apart", async () => {
    const cloudFront = fakeCloudFront([
      { $metadata: {} },
      error(CNAMEAlreadyExists),
      { $metadata: {}, DistributionTenant: stored, ETag: "E1" },
      error(CNAMEAlreadyExists),
      error(EntityNotFound),
      error(InvalidArgument),
      error(AccessDenied),
    ]);
    const tenant = {
      appId: "01J00000000000000000000001",
      hostname: "www.example.com",
      name: "app-domain-01J00000000000000000000000",
    };

    expect(await cloudFront.edge.create(tenant)).toBe("created");
    expect(await cloudFront.edge.create(tenant)).toBe("exists");
    expect(await cloudFront.edge.create(tenant)).toBe("domain-taken");
    expect(await cloudFront.edge.create(tenant)).toBe("rejected");
    const denied = await cloudFront.edge.create(tenant).catch((failure: unknown) => failure);
    expect(denied).toBeInstanceOf(AccessDenied);
    expect(cloudFront.sent[0]).toEqual({
      command: "CreateDistributionTenantCommand",
      input: {
        ConnectionGroupId: "cg_example",
        DistributionId: DISTRIBUTION_ID,
        Domains: [{ Domain: "www.example.com" }],
        Enabled: true,
        ManagedCertificateRequest: {
          PrimaryDomainName: "www.example.com",
          ValidationTokenHost: "cloudfront",
        },
        Name: "app-domain-01J00000000000000000000000",
        Parameters: [{ Name: "appId", Value: "01J00000000000000000000001" }],
        Tags: { Items: [{ Key: "deployments:managed-by", Value: "apps" }] },
      },
    });
  });
});
