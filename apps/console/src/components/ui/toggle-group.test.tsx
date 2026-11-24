import { describe, expect, test } from "bun:test";
import { withClient } from "@/components/ui/render-client";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

describe("SingleToggleGroup", () => {
  test("emits the newly pressed value and nothing when the pressed item is clicked again", async () => {
    const emitted: string[] = [];
    let pressed: (string | null | undefined)[] = [];
    await withClient(
      <SingleToggleGroup aria-label="Range" value="a" onValueChange={(next) => emitted.push(next)}>
        <ToggleGroupItem value="a">A</ToggleGroupItem>
        <ToggleGroupItem value="b">B</ToggleGroupItem>
      </SingleToggleGroup>,
      async (view) => {
        const [a, b] = view.document.querySelectorAll("button");
        pressed = [a?.getAttribute("aria-pressed"), b?.getAttribute("aria-pressed")];
        await view.click(a);
        await view.click(b);
      },
    );
    expect({ pressed, emitted }).toEqual({ pressed: ["true", "false"], emitted: ["b"] });
  });
});
