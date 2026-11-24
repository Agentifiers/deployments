import { describe, expect, test } from "bun:test";
import { withClient } from "@/components/ui/render-client";

const ADDED = ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
const SHADOWED = ["navigator", "Event"];
const presence = (keys: string[]) => keys.map((key) => Object.hasOwn(globalThis, key));
const values = () => SHADOWED.map((key) => Reflect.get(globalThis, key));

describe("withClient", () => {
  test("installs a DOM for the callback and leaves globals exactly as it found them", async () => {
    const before = { added: presence(ADDED), shadowed: presence(SHADOWED) };
    const originals = values();
    let inside: { added: boolean[]; replaced: boolean[] } = { added: [], replaced: [] };
    await withClient(<p>hi</p>, async () => {
      inside = {
        added: presence(ADDED),
        replaced: values().map((value, index) => value !== originals[index]),
      };
    });
    expect({
      before,
      inside,
      after: {
        added: presence(ADDED),
        shadowed: presence(SHADOWED),
        same: values().map((value, index) => value === originals[index]),
      },
    }).toEqual({
      before: { added: [false, false, false, false], shadowed: [true, true] },
      inside: { added: [true, true, true, true], replaced: [true, true] },
      after: { added: [false, false, false, false], shadowed: [true, true], same: [true, true] },
    });
  });
});
