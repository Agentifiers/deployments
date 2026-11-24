import {
  CreateDistributionTenantCommand,
  DeleteDistributionTenantCommand,
  GetDistributionTenantByDomainCommand,
  GetDistributionTenantCommand,
  GetManagedCertificateDetailsCommand,
  ListDistributionTenantsCommand,
  ListTagsForResourceCommand,
  ManagedCertificateStatus,
  UpdateDistributionTenantCommand,
  type CloudFrontClient,
  type DistributionTenant,
  type DistributionTenantSummary,
  type UpdateDistributionTenantCommandInput,
} from "@aws-sdk/client-cloudfront";
import { MANAGED_TAG, type EdgeTenants, type Tenant, type TenantWrite } from "./edge.ts";

const STALE_WRITE_ERRORS = new Set([
  "EntityNotFound",
  "InvalidIfMatchVersion",
  "PreconditionFailed",
  "ResourceNotDisabled",
]);
const MANAGED_CERTIFICATE_STATUSES = new Set<string>(Object.values(ManagedCertificateStatus));

function errorName(error: unknown) {
  return error instanceof Error ? error.name : undefined;
}

async function unlessNotFound<Value>(request: Promise<Value>) {
  try {
    return await request;
  } catch (error) {
    if (errorName(error) === "EntityNotFound") return undefined;
    throw error;
  }
}

function required<Value>(value: Value | undefined, field: string): Value {
  if (value === undefined) throw new Error(`CloudFront returned a tenant without ${field}.`);
  return value;
}

function observed(
  tenant: DistributionTenant | DistributionTenantSummary,
  etag: string | undefined,
  distributionId: string,
): Tenant {
  const domains = tenant.Domains ?? [];
  return {
    arn: required(tenant.Arn, "Arn"),
    certificateArn: tenant.Customizations?.Certificate?.Arn,
    deployed: tenant.Status === "Deployed",
    domainActive: domains.length > 0 && domains.every((domain) => domain.Status === "active"),
    enabled: tenant.Enabled === true,
    etag: required(etag, "ETag"),
    hostname: domains[0]?.Domain,
    id: required(tenant.Id, "Id"),
    name: required(tenant.Name, "Name"),
    onDistribution: tenant.DistributionId === distributionId,
  };
}

export function cloudFrontEdge(options: {
  readonly client: CloudFrontClient;
  readonly connectionGroupId: string;
  readonly distributionId: string;
}): EdgeTenants {
  const { client, connectionGroupId, distributionId } = options;

  async function update(
    seen: Tenant,
    change: (
      tenant: DistributionTenant,
    ) => Pick<
      UpdateDistributionTenantCommandInput,
      "Customizations" | "Enabled" | "ManagedCertificateRequest"
    >,
  ): Promise<TenantWrite> {
    const current = await unlessNotFound(
      client.send(new GetDistributionTenantCommand({ Identifier: seen.id })),
    );
    const tenant = current?.DistributionTenant;
    if (!tenant || current.ETag !== seen.etag) return "stale";
    try {
      await client.send(
        new UpdateDistributionTenantCommand({
          ConnectionGroupId: tenant.ConnectionGroupId,
          Customizations: tenant.Customizations,
          DistributionId: tenant.DistributionId,
          Domains: tenant.Domains?.map(({ Domain }) => ({ Domain })),
          Enabled: tenant.Enabled,
          Id: seen.id,
          IfMatch: seen.etag,
          Parameters: tenant.Parameters,
          ...change(tenant),
        }),
      );
      return "applied";
    } catch (error) {
      if (STALE_WRITE_ERRORS.has(errorName(error) ?? "")) return "stale";
      throw error;
    }
  }

  async function get(identifier: string) {
    const result = await unlessNotFound(
      client.send(new GetDistributionTenantCommand({ Identifier: identifier })),
    );
    return result?.DistributionTenant?.DistributionId === distributionId
      ? observed(result.DistributionTenant, result.ETag, distributionId)
      : undefined;
  }

  return {
    async list() {
      const tenants: Tenant[] = [];
      let marker: string | undefined;
      do {
        const page = await client.send(
          new ListDistributionTenantsCommand(marker ? { Marker: marker } : {}),
        );
        for (const tenant of page.DistributionTenantList ?? []) {
          tenants.push(observed(tenant, tenant.ETag, distributionId));
        }
        marker = page.NextMarker;
      } while (marker);
      return tenants;
    },

    get,

    async holderOf(hostname) {
      const result = await unlessNotFound(
        client.send(new GetDistributionTenantByDomainCommand({ Domain: hostname })),
      );
      const tenant = result?.DistributionTenant;
      return (
        tenant && {
          arn: required(tenant.Arn, "Arn"),
          onDistribution: tenant.DistributionId === distributionId,
        }
      );
    },

    async isManaged({ arn }) {
      const result = await client.send(new ListTagsForResourceCommand({ Resource: arn }));
      return (result.Tags?.Items ?? []).some(
        (tag) => tag.Key === MANAGED_TAG.key && tag.Value === MANAGED_TAG.value,
      );
    },

    async create({ appId, hostname, name }) {
      try {
        await client.send(
          new CreateDistributionTenantCommand({
            ConnectionGroupId: connectionGroupId,
            DistributionId: distributionId,
            Domains: [{ Domain: hostname }],
            Enabled: true,
            ManagedCertificateRequest: {
              PrimaryDomainName: hostname,
              ValidationTokenHost: "cloudfront",
            },
            Name: name,
            Parameters: [{ Name: "appId", Value: appId }],
            Tags: { Items: [{ Key: MANAGED_TAG.key, Value: MANAGED_TAG.value }] },
          }),
        );
        return "created";
      } catch (error) {
        const code = errorName(error);
        if (code === "InvalidArgument") return "rejected";
        if (code !== "CNAMEAlreadyExists" && code !== "EntityAlreadyExists") throw error;
        return (await get(name)) ? "exists" : "domain-taken";
      }
    },

    async managedCertificate(tenant) {
      const result = await unlessNotFound(
        client.send(new GetManagedCertificateDetailsCommand({ Identifier: tenant.id })),
      );
      const arn = result?.ManagedCertificateDetails?.CertificateArn;
      const status = result?.ManagedCertificateDetails?.CertificateStatus;
      if (!arn || !status) return undefined;
      if (!MANAGED_CERTIFICATE_STATUSES.has(status)) {
        throw new Error(`CloudFront reported an unknown certificate status ${status}.`);
      }
      return { arn, status };
    },

    attachCertificate: (seen, certificateArn) =>
      update(seen, (tenant) => ({
        Customizations: { ...tenant.Customizations, Certificate: { Arn: certificateArn } },
      })),

    requestCertificate: (seen) =>
      update(seen, (tenant) => ({
        ManagedCertificateRequest: {
          PrimaryDomainName: required(tenant.Domains?.[0]?.Domain, "Domains"),
          ValidationTokenHost: "cloudfront",
        },
      })),

    disable: (seen) => update(seen, () => ({ Enabled: false })),

    async delete(seen) {
      try {
        await client.send(new DeleteDistributionTenantCommand({ Id: seen.id, IfMatch: seen.etag }));
        return "applied";
      } catch (error) {
        if (STALE_WRITE_ERRORS.has(errorName(error) ?? "")) return "stale";
        throw error;
      }
    },
  };
}
