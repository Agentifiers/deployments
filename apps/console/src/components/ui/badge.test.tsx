import { describe, expect, test } from "bun:test";
import { Badge } from "@/components/ui/badge";
import { renderDocument } from "@/components/ui/render-document";

describe("Badge", () => {
  test("renders each console color at least 24px tall, zinc by default", async () => {
    const doc = await renderDocument(
      <>
        <Badge>default</Badge>
        <Badge color="sky">sky</Badge>
        <Badge color="blue">blue</Badge>
      </>,
    );
    expect(
      [...doc.querySelectorAll('[data-slot="badge"]')].map((node) => {
        const names = node.className.split(" ");
        return [
          node.textContent,
          names.includes("min-h-6"),
          names.filter((name) => /^(bg|text)-(zinc|sky|info)/.test(name)),
        ];
      }),
    ).toEqual([
      ["default", true, ["bg-zinc-600/10", "text-zinc-700"]],
      ["sky", true, ["bg-sky-500/10", "text-sky-900"]],
      ["blue", true, ["bg-info/10", "text-info-foreground"]],
    ]);
  });

  test("wraps and shrinks inside a narrow container instead of overflowing it", async () => {
    const doc = await renderDocument(<Badge color="amber">reauthorization-required</Badge>);
    const names = doc.querySelector('[data-slot="badge"]')?.className.split(" ") ?? [];
    expect({
      fixedHeight: names.includes("h-6"),
      nowrap: names.includes("whitespace-nowrap"),
      noShrink: names.includes("shrink-0"),
      wraps: names.includes("whitespace-normal"),
      shrinks: names.includes("shrink"),
    }).toEqual({ fixedHeight: false, nowrap: false, noShrink: false, wraps: true, shrinks: true });
  });
});
