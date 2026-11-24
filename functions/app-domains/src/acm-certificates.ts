import {
  AddTagsToCertificateCommand,
  DeleteCertificateCommand,
  KeyAlgorithm,
  ListCertificatesCommand,
  ListTagsForCertificateCommand,
  type ACMClient,
  type CertificateSummary,
} from "@aws-sdk/client-acm";
import { MANAGED_TAG, type AccountCertificate, type Certificates } from "./edge.ts";

function errorName(error: unknown) {
  return error instanceof Error ? error.name : undefined;
}

function required<Value>(value: Value | undefined, field: string, arn: string): Value {
  if (value === undefined) throw new Error(`ACM listed ${arn} without ${field}.`);
  return value;
}

function accountCertificate(arn: string, summary: CertificateSummary): AccountCertificate {
  const inUse = summary.InUse === true;
  if (summary.ManagedBy !== "CLOUDFRONT") return { arn, inUse, managedByCloudFront: false };
  return {
    arn,
    hostname: required(summary.DomainName, "DomainName", arn),
    inUse,
    managedByCloudFront: true,
    requestedAt: required(summary.CreatedAt, "CreatedAt", arn),
  };
}

export function acmCertificates(client: ACMClient): Certificates {
  return {
    async list() {
      const certificates: AccountCertificate[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListCertificatesCommand({
            // Without keyTypes ACM lists only RSA certificates; CloudFront-managed ones are EC.
            Includes: { keyTypes: Object.values(KeyAlgorithm) },
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        );
        for (const summary of page.CertificateSummaryList ?? []) {
          if (summary.CertificateArn) {
            certificates.push(accountCertificate(summary.CertificateArn, summary));
          }
        }
        nextToken = page.NextToken;
      } while (nextToken);
      return certificates;
    },

    async isManaged(arn) {
      try {
        const result = await client.send(
          new ListTagsForCertificateCommand({ CertificateArn: arn }),
        );
        return (result.Tags ?? []).some(
          (tag) => tag.Key === MANAGED_TAG.key && tag.Value === MANAGED_TAG.value,
        );
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return false;
        throw error;
      }
    },

    async markManaged(arn) {
      try {
        await client.send(
          new AddTagsToCertificateCommand({
            CertificateArn: arn,
            Tags: [{ Key: MANAGED_TAG.key, Value: MANAGED_TAG.value }],
          }),
        );
      } catch (error) {
        // CloudFront keeps reporting a draining tenant's certificate after a sweep deleted it.
        if (errorName(error) !== "ResourceNotFoundException") throw error;
      }
    },

    async delete(arn) {
      try {
        await client.send(new DeleteCertificateCommand({ CertificateArn: arn }));
        return "deleted";
      } catch (error) {
        const code = errorName(error);
        if (code === "ResourceInUseException") return "in-use";
        if (code === "ResourceNotFoundException") return "gone";
        if (code === "ConflictException") return "busy";
        throw error;
      }
    },
  };
}
