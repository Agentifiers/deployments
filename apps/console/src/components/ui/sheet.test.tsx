import { describe, expect, test } from "bun:test";
import { withClient } from "@/components/ui/render-client";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const classes = (element: Element | null | undefined) => element?.className.split(" ") ?? [];

describe("SheetContent", () => {
  test("keeps the header in view by scrolling the body, and lets a call-site width win", async () => {
    const seen: unknown[] = [];
    await withClient(
      <Sheet open>
        <SheetContent className="sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Release skills to production environments</SheetTitle>
          </SheetHeader>
          <SheetBody>Body</SheetBody>
        </SheetContent>
      </Sheet>,
      async (view) => {
        const content = classes(view.document.querySelector('[data-slot="sheet-content"]'));
        seen.push(
          content.filter((name) => name.startsWith("overflow-") || name.includes("max-w-")),
          classes(view.document.querySelector('[data-slot="sheet-header"]')).filter((name) =>
            ["pr-12"].includes(name),
          ),
          classes(view.document.querySelector('[data-slot="sheet-body"]')).filter((name) =>
            ["min-h-0", "flex-1", "overflow-y-auto", "px-4", "pb-1"].includes(name),
          ),
        );
      },
    );
    expect(seen).toEqual([
      ["overflow-hidden", "sm:max-w-2xl"],
      ["pr-12"],
      ["min-h-0", "flex-1", "overflow-y-auto", "px-4", "pb-1"],
    ]);
  });

  test("side sheets fill the phone width and cap at sm; top and bottom sheets span the width", async () => {
    const sides = ["left", "right", "top", "bottom"] as const;
    const widths: string[][] = [];
    for (const side of sides) {
      await withClient(
        <Sheet open>
          <SheetContent side={side}>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
          </SheetContent>
        </Sheet>,
        async (view) => {
          widths.push(
            classes(view.document.querySelector('[data-slot="sheet-content"]')).filter(
              (name) => name.includes("max-w-") || /^data-\[side=(left|right)\]:w-/.test(name),
            ),
          );
        },
      );
    }
    const sideWidths = ["data-[side=left]:w-full", "data-[side=right]:w-full"];
    expect(widths).toEqual([
      [...sideWidths, "sm:max-w-sm"],
      [...sideWidths, "sm:max-w-sm"],
      sideWidths,
      sideWidths,
    ]);
  });
});
