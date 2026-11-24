import { describe, expect, test } from "bun:test";
import { renderDocument } from "@/components/ui/render-document";
import { Textarea } from "@/components/ui/textarea";

const classes = (element: Element | undefined) => element?.className.split(" ") ?? [];

describe("Textarea", () => {
  test("sizes by rows and resizes vertically unless resizable is false", async () => {
    const doc = await renderDocument(
      <>
        <Textarea rows={2} />
        <Textarea resizable={false} rows={9} />
      </>,
    );
    const [resizable, fixed] = doc.querySelectorAll("textarea");
    expect(
      [resizable, fixed].map((textarea) => ({
        rows: textarea?.getAttribute("rows"),
        contentSized: classes(textarea).some(
          (name) => name === "field-sizing-content" || name.startsWith("min-h-"),
        ),
        resize: classes(textarea).filter((name) => name.startsWith("resize")),
      })),
    ).toEqual([
      { rows: "2", contentSized: false, resize: ["resize-y"] },
      { rows: "9", contentSized: false, resize: ["resize-none"] },
    ]);
  });
});
