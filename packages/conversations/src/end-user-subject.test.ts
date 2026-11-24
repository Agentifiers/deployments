import { expect, test } from "bun:test";
import { endUserKeyDeriver } from "./end-user-subject.ts";

test("derives the stored v1 end-user key for an organization and end user", () => {
  const derive = endUserKeyDeriver("end-user-subject-test-key-0123456789abcdef");

  expect<string>(derive("01ARZ3NDEKTSV4RRFFQ69G5FAV", "customer-42")).toBe(
    "v1.VnDIg3OIkS64o_epUIInPYLHht8_km3ni5eAV_Qcp-s",
  );
});
