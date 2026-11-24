import { Schema } from "effect";
import { DIRECTORY_CONTROL_RECORD_SCHEMAS } from "../records/directory.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { DirectoryItemType } from "./record-rules.ts";

export type DirectoryRecord<ItemType extends DirectoryItemType> =
  (typeof DIRECTORY_CONTROL_RECORD_SCHEMAS)[ItemType]["Type"];

export function directoryRecord<ItemType extends DirectoryItemType>(
  itemType: ItemType,
  data: DirectoryRecord<ItemType>["data"],
): DirectoryRecord<ItemType> {
  const decode = Schema.decodeUnknownSync(DIRECTORY_CONTROL_RECORD_SCHEMAS[itemType]) as (
    input: unknown,
  ) => DirectoryRecord<ItemType>;
  return decode(withCanonicalRecordKeys({ data, itemType }));
}
