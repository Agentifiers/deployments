import type { DynamoDatabaseService } from "../client-types.ts";
import type { PlatformRecord, TableName } from "../records/index.ts";
import { workerPersistence } from "../domain-persistence.ts";

type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;

export function makeSlackAgentStreamPersistence(database: DynamoDatabaseService) {
  return {
    load(table: Extract<TableName, "control" | "execution">, pk: string, sk: string) {
      return workerPersistence.read(database, table, { pk, sk }, true);
    },
    async save(record: SlackStream, previous?: SlackStream) {
      if (previous) {
        await workerPersistence.commit(database, [
          { kind: "put", previousRecord: previous, record },
        ]);
      } else {
        await workerPersistence.write(
          database,
          record,
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        );
      }
      return record;
    },
  };
}
