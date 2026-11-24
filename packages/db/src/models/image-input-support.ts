import {
  catalogLookupModelIds,
  imageInputSupport,
  type ImageInputSupport,
} from "@deployments-ai/model-gateway";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeModelCatalogPersistence } from "./catalog-persistence.ts";

export async function loadModelImageInputSupport(
  database: DynamoDatabaseService,
  modelId: string,
): Promise<ImageInputSupport> {
  return imageInputSupport(
    modelId,
    await makeModelCatalogPersistence(database).getEntries(catalogLookupModelIds([modelId])),
  );
}
