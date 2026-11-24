import { describe, expect, test } from "bun:test";
import { Button } from "@/components/ui/button";
import { renderDocument } from "@/components/ui/render-document";

describe("Button", () => {
  test("defaults to type=button, so it never submits the form it sits in", async () => {
    const doc = await renderDocument(
      <form>
        <Button>Copy</Button>
        <Button type="submit">Save</Button>
      </form>,
    );
    expect([...doc.querySelectorAll("button")].map((button) => button.type)).toEqual([
      "button",
      "submit",
    ]);
  });

  test("renders a router link for href", async () => {
    const doc = await renderDocument(
      <Button href="/o/org-1/p/project-1?tab=keys" variant="outline">
        Open
      </Button>,
    );
    const link = doc.querySelector('[data-slot="button"]');
    expect({
      tag: link?.tagName,
      href: link?.getAttribute("href"),
      role: link?.getAttribute("role"),
      text: link?.textContent,
    }).toEqual({ tag: "A", href: "/o/org-1/p/project-1?tab=keys", role: null, text: "Open" });
  });

  test("every variant paints the same 32px box, border included", async () => {
    const variants = ["default", "outline", "secondary", "ghost", "destructive"] as const;
    const doc = await renderDocument(
      <>
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </>,
    );
    expect(
      [...doc.querySelectorAll("button")].map((button) => {
        const names = button.className.split(" ");
        return [names.includes("h-8"), names.includes("border"), names.includes("bg-clip-padding")];
      }),
    ).toEqual(variants.map(() => [true, true, false]));
  });
});
