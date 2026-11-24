import type { DynamoDatabaseService } from "../client-types.ts";

export async function readRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await database.getRecord(table, recordKey, true);
}
