import type { BrainDocumentRendition, BrainRepository } from "@deployments-ai/brains";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  brainDocumentRenditionFromPlatformRecord,
  brainDocumentRenditionPlatformRecord,
} from "./record-mapping.ts";

export function makeBrainRenditionRepository(
  database: DynamoDatabaseService,
): Pick<BrainRepository, "getDocumentRendition"> {
  return {
    async getDocumentRendition(organizationId, documentVersionId, renditionId) {
      const record = await database.getRecord(
        "control",
        {
          pk: key("ORG", organizationId, "DOCUMENT-VERSION", documentVersionId),
          sk: key("BRAIN-DOCUMENT-RENDITION", renditionId),
        },
        true,
      );
      return record?.itemType === "brain-document-rendition" &&
        record.data.documentVersionId === documentVersionId
        ? brainDocumentRenditionFromPlatformRecord(record)
        : undefined;
    },
  };
}

export async function createOrAdoptBrainDocumentRendition(input: {
  readonly database: DynamoDatabaseService;
  readonly rendition: BrainDocumentRendition;
}): Promise<BrainDocumentRendition> {
  const record = brainDocumentRenditionPlatformRecord(input.rendition);
  try {
    await input.database.transactWrite([{ kind: "put", record }]);
    return brainDocumentRenditionFromPlatformRecord(record);
  } catch (cause) {
    if (!isDatabaseWriteConflict(cause)) throw cause;
    const stored = await makeBrainRenditionRepository(input.database).getDocumentRendition(
      record.data.organizationId,
      record.data.documentVersionId,
      record.data.id,
    );
    if (!stored) throw cause;
    return stored;
  }
}
