import { describe, expect, test } from "bun:test";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { renderDocument } from "@/components/ui/render-document";

const classes = (doc: Document, slot: string) =>
  doc.querySelector(`[data-slot="${slot}"]`)?.className.split(" ") ?? [];

describe("Empty", () => {
  test("draws a dashed border with a 48px icon tile and a semibold title", async () => {
    const doc = await renderDocument(
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <svg />
          </EmptyMedia>
          <EmptyTitle>No traces</EmptyTitle>
        </EmptyHeader>
      </Empty>,
    );
    expect({
      border: ["border", "border-dashed"].map((name) => classes(doc, "empty").includes(name)),
      icon: classes(doc, "empty-icon").filter(
        (name) =>
          name.startsWith("size-") ||
          name.includes(":size-") ||
          name.startsWith("rounded-") ||
          name.startsWith("text-"),
      ),
      title: classes(doc, "empty-title").filter(
        (name) => name.startsWith("text-") || name.startsWith("font-"),
      ),
      titleElement: doc.querySelector('[data-slot="empty-title"]')?.tagName,
    }).toEqual({
      border: [true, true],
      icon: [
        "size-12",
        "rounded-xl",
        "text-muted-foreground",
        "[&_svg:not([class*='size-'])]:size-6",
      ],
      title: ["font-heading", "text-base/6", "font-semibold"],
      titleElement: "H4",
    });
  });
});
