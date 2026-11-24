import { describe, expect, test } from "bun:test";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { withClient } from "@/components/ui/render-client";

describe("DropdownMenuContent", () => {
  test("sizes to its items, at least as wide as the trigger", async () => {
    let names: string[] = [];
    await withClient(
      <DropdownMenu open>
        <DropdownMenuTrigger>Export</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>Download traces as JSON lines</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
      async (view) => {
        names =
          view.document
            .querySelector('[data-slot="dropdown-menu-content"]')
            ?.className.split(" ") ?? [];
      },
    );
    expect(names.filter((name) => /^(min-)?w-/.test(name))).toEqual([
      "w-max",
      "min-w-(--anchor-width)",
    ]);
  });
});
