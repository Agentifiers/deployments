import { describe, expect, it } from "bun:test";
import { memoryIndexMessageGroup } from "./index-dispatcher.ts";

describe("memory index dispatcher", () => {
  it("orders one memory target without serializing unrelated tenants or memories", () => {
    const event = {
      detail: {
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        payload: {
          memoryId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          targetId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        },
      },
    };
    const first = memoryIndexMessageGroup(event);
    const replay = memoryIndexMessageGroup(event);
    const other = memoryIndexMessageGroup({
      detail: { ...event.detail, organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
    });

    expect(first).toBe(replay);
    expect(first).not.toBe(other);
    expect(first).toHaveLength(64);
  });
});
