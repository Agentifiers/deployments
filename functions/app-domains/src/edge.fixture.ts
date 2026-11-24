import {
  type AccountCertificate,
  type Certificates,
  type EdgeTenants,
  type ManagedCertificateStatus,
  type Tenant,
} from "./edge.ts";

interface FakeTenant {
  appId: string;
  certificateArn: string | undefined;
  deployed: boolean;
  distribution: "ours" | "other";
  domainActive: boolean;
  enabled: boolean;
  hostname: string;
  id: string;
  managed: boolean;
  managedCertificateArn: string | undefined;
  name: string;
  version: number;
}

interface FakeCertificate {
  arn: string;
  hostname: string;
  listedAt: Date;
  managed: boolean;
  managedByCloudFront: boolean;
  requestedAt: Date;
  status: ManagedCertificateStatus;
}

export class AccessDenied extends Error {}

/**
 * CloudFront and ACM as the reconciler sees them. Writes need the observed ETag, deletes need a
 * disabled and deployed tenant, and writes to untagged tenants or certificates are denied the way
 * the tag-scoped IAM policy denies them. ACM lists a new certificate only once
 * `lagListingOfNewCertificates` has passed, because ListCertificates is not read-after-write
 * consistent.
 */
export function fakeEdge(options: { readonly now: () => Date }) {
  const tenants = new Map<string, FakeTenant>();
  const certificateByArn = new Map<string, FakeCertificate>([
    [
      "arn:acm:viewer",
      {
        arn: "arn:acm:viewer",
        hostname: "*.apps.example.test",
        listedAt: options.now(),
        managed: false,
        managedByCloudFront: false,
        requestedAt: options.now(),
        status: "issued",
      },
    ],
  ]);
  const foreignHostnames = new Set<string>();
  const unroutedHostnames = new Set<string>();
  let sequence = 0;
  let listingLagMs = 0;
  const writes: string[] = [];
  const createAttempts: string[] = [];

  function yieldTurn() {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    return promise;
  }
  const arnOf = (tenant: FakeTenant) => `arn:cloudfront:distribution-tenant/${tenant.id}`;
  const byArn = (arn: string) => [...tenants.values()].find((tenant) => arnOf(tenant) === arn);
  const ours = () => [...tenants.values()].filter((tenant) => tenant.distribution === "ours");

  function observed(tenant: FakeTenant): Tenant {
    return {
      arn: arnOf(tenant),
      certificateArn: tenant.certificateArn,
      deployed: tenant.deployed,
      domainActive: tenant.domainActive,
      enabled: tenant.enabled,
      etag: `E${tenant.version}`,
      hostname: tenant.hostname,
      id: tenant.id,
      name: tenant.name,
      onDistribution: tenant.distribution === "ours",
    };
  }

  function addCertificate(input: Omit<FakeCertificate, "arn" | "listedAt">) {
    sequence += 1;
    const arn = `arn:acm:managed-${sequence}`;
    const listedAt = new Date(options.now().getTime() + listingLagMs);
    certificateByArn.set(arn, { arn, listedAt, ...input });
    return arn;
  }

  const requestCertificate = (hostname: string) =>
    addCertificate({
      hostname,
      managed: false,
      managedByCloudFront: true,
      requestedAt: options.now(),
      status: "pending-validation",
    });

  function inUse(arn: string) {
    return [...tenants.values()].some((tenant) => tenant.certificateArn === arn);
  }

  async function write(
    operation: string,
    seen: Tenant,
    change: (tenant: FakeTenant) => void,
  ): Promise<"applied" | "stale"> {
    await yieldTurn();
    const tenant = tenants.get(seen.id);
    if (!tenant) return "stale";
    if (!tenant.managed) throw new AccessDenied(`${operation} denied on untagged ${tenant.name}`);
    if (`E${tenant.version}` !== seen.etag) return "stale";
    change(tenant);
    tenant.version += 1;
    writes.push(`${operation} ${tenant.name}`);
    return "applied";
  }

  function addTenant(input: {
    readonly distribution?: "ours" | "other";
    readonly hostname: string;
    readonly managed: boolean;
    readonly name: string;
  }) {
    sequence += 1;
    const tenant: FakeTenant = {
      appId: "01J00000000000000000000000",
      certificateArn: undefined,
      deployed: true,
      distribution: input.distribution ?? "ours",
      domainActive: false,
      enabled: true,
      hostname: input.hostname,
      id: `dt_${sequence}`,
      managed: input.managed,
      managedCertificateArn: undefined,
      name: input.name,
      version: 1,
    };
    tenants.set(tenant.id, tenant);
    return tenant;
  }

  function serving(tenant: FakeTenant) {
    const certificateArn = addCertificate({
      hostname: tenant.hostname,
      managed: false,
      managedByCloudFront: true,
      requestedAt: options.now(),
      status: "issued",
    });
    Object.assign(tenant, {
      certificateArn,
      domainActive: true,
      managedCertificateArn: certificateArn,
    });
    return tenant;
  }

  const edge: EdgeTenants = {
    async list() {
      await yieldTurn();
      return [...tenants.values()].map(observed);
    },
    async get(name) {
      await yieldTurn();
      const tenant = ours().find((candidate) => candidate.name === name);
      return tenant && observed(tenant);
    },
    async holderOf(hostname) {
      await yieldTurn();
      const tenant = [...tenants.values()].find(
        (candidate) => candidate.hostname === hostname && candidate.domainActive,
      );
      return tenant && { arn: arnOf(tenant), onDistribution: tenant.distribution === "ours" };
    },
    async isManaged({ arn }) {
      await yieldTurn();
      return byArn(arn)?.managed ?? false;
    },
    async create({ appId, hostname, name }) {
      await yieldTurn();
      createAttempts.push(hostname);
      if (unroutedHostnames.has(hostname)) return "rejected";
      const nameTaken = ours().some((tenant) => tenant.name === name);
      const hostnameTaken =
        foreignHostnames.has(hostname) ||
        [...tenants.values()].some((tenant) => tenant.hostname === hostname);
      if (nameTaken || hostnameTaken) {
        requestCertificate(hostname);
        return nameTaken ? "exists" : "domain-taken";
      }
      const tenant = addTenant({ hostname, managed: true, name });
      Object.assign(tenant, {
        appId,
        deployed: false,
        managedCertificateArn: requestCertificate(hostname),
      });
      writes.push(`create ${name}`);
      return "created";
    },
    async managedCertificate(seen) {
      await yieldTurn();
      const arn = tenants.get(seen.id)?.managedCertificateArn;
      const certificate = arn ? certificateByArn.get(arn) : undefined;
      return certificate && { arn: certificate.arn, status: certificate.status };
    },
    attachCertificate: (seen, certificateArn) =>
      write("attach-certificate", seen, (tenant) => {
        if (certificateByArn.get(certificateArn)?.status !== "issued") {
          throw new Error(`${certificateArn} is not issued.`);
        }
        Object.assign(tenant, { certificateArn, deployed: false, domainActive: tenant.enabled });
      }),
    requestCertificate: (seen) =>
      write("request-certificate", seen, (tenant) => {
        Object.assign(tenant, {
          deployed: false,
          managedCertificateArn: requestCertificate(tenant.hostname),
        });
      }),
    disable: (seen) =>
      write("disable", seen, (tenant) => {
        Object.assign(tenant, { deployed: false, enabled: false });
      }),
    delete: (seen) =>
      write("delete", seen, (tenant) => {
        if (tenant.enabled || !tenant.deployed) {
          throw new Error(`${tenant.name} must be disabled and deployed before deletion.`);
        }
        tenants.delete(tenant.id);
      }),
  };

  const certificates: Certificates = {
    async list() {
      await yieldTurn();
      return [...certificateByArn.values()]
        .filter((certificate) => certificate.listedAt <= options.now())
        .map(
          (certificate): AccountCertificate =>
            certificate.managedByCloudFront
              ? {
                  arn: certificate.arn,
                  hostname: certificate.hostname,
                  inUse: inUse(certificate.arn),
                  managedByCloudFront: true,
                  requestedAt: certificate.requestedAt,
                }
              : { arn: certificate.arn, inUse: inUse(certificate.arn), managedByCloudFront: false },
        );
    },
    async isManaged(arn) {
      await yieldTurn();
      return certificateByArn.get(arn)?.managed ?? false;
    },
    async markManaged(arn) {
      await yieldTurn();
      const certificate = certificateByArn.get(arn);
      if (certificate) certificate.managed = true;
    },
    async delete(arn) {
      await yieldTurn();
      const certificate = certificateByArn.get(arn);
      if (!certificate) return "gone";
      if (!certificate.managed) throw new AccessDenied(`delete denied on untagged ${arn}`);
      if (inUse(arn)) return "in-use";
      certificateByArn.delete(arn);
      writes.push(`delete-certificate ${certificate.hostname}`);
      return "deleted";
    },
  };

  function tenantFor(hostname: string) {
    const tenant = [...tenants.values()].find((candidate) => candidate.hostname === hostname);
    if (!tenant) throw new Error(`No tenant holds ${hostname}.`);
    return tenant;
  }

  return {
    certificates,
    edge,
    addUntaggedTenant: (name: string, hostname: string) =>
      addTenant({ hostname, managed: false, name }),
    addServingUntaggedTenant: (name: string, hostname: string) =>
      serving(addTenant({ hostname, managed: false, name })),
    addOtherDistributionTenant: (name: string, hostname: string) =>
      serving(addTenant({ distribution: "other", hostname, managed: false, name })),
    /** An untagged tenant of another distribution whose managed certificate is still pending. */
    addPendingOtherDistributionTenant(name: string, hostname: string, requestedAt: Date) {
      const tenant = addTenant({ distribution: "other", hostname, managed: false, name });
      tenant.managedCertificateArn = addCertificate({
        hostname,
        managed: false,
        managedByCloudFront: true,
        requestedAt,
        status: "pending-validation",
      });
      return tenant;
    },
    addLeftoverCertificate: (hostname: string, requestedAt: Date) =>
      addCertificate({
        hostname,
        managed: false,
        managedByCloudFront: true,
        requestedAt,
        status: "failed",
      }),
    holdElsewhere: (hostname: string) => foreignHostnames.add(hostname),
    release: (hostname: string) => foreignHostnames.delete(hostname),
    lagListingOfNewCertificates(milliseconds: number) {
      listingLagMs = milliseconds;
    },
    forgetManagedCertificate(hostname: string) {
      tenantFor(hostname).managedCertificateArn = undefined;
    },
    /** CloudFront answers InvalidArgument and requests no certificate, as measured for such a create. */
    pointDnsElsewhere: (hostname: string) => unroutedHostnames.add(hostname),
    pointDnsHere: (hostname: string) => unroutedHostnames.delete(hostname),
    createAttempts: () => [...createAttempts],
    /** Every in-progress tenant finishes deploying. */
    propagate() {
      for (const tenant of tenants.values()) tenant.deployed = true;
    },
    settleCertificate(hostname: string, status: ManagedCertificateStatus) {
      const arn = tenantFor(hostname).managedCertificateArn;
      const certificate = arn ? certificateByArn.get(arn) : undefined;
      if (!certificate) throw new Error(`${hostname} has no managed certificate.`);
      certificate.status = status;
    },
    tenants: () =>
      [...tenants.values()]
        .filter((tenant) => tenant.distribution === "ours")
        .map((tenant) => ({
          certificate: tenant.certificateArn ? "attached" : "none",
          domainActive: tenant.domainActive,
          enabled: tenant.enabled,
          hostname: tenant.hostname,
          name: tenant.name,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    managedCertificates: () =>
      [...certificateByArn.values()]
        .filter((certificate) => certificate.managedByCloudFront)
        .map((certificate) => ({
          hostname: certificate.hostname,
          inUse: inUse(certificate.arn),
          status: certificate.status,
          tagged: certificate.managed,
        })),
    writes: () => [...writes],
  };
}
