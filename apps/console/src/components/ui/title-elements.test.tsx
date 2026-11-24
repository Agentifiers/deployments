import { describe, expect, test } from "bun:test";
import { Callout, CalloutTitle } from "@/components/ui/callout";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList, DescriptionTerm } from "@/components/ui/description-list";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Heading, Subheading } from "@/components/ui/heading";
import { withClient } from "@/components/ui/render-client";
import { renderDocument } from "@/components/ui/render-document";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

describe("title parts", () => {
  test("render heading elements, so they stay in the heading outline", async () => {
    const doc = await renderDocument(
      <>
        <Heading>Heading</Heading>
        <Heading level={2}>Heading level 2</Heading>
        <Subheading>Subheading</Subheading>
        <Subheading level={3}>Subheading level 3</Subheading>
        <Card>
          <CardHeader>
            <CardTitle>Card</CardTitle>
          </CardHeader>
        </Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Empty</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <Callout>
          <CalloutTitle>Callout</CalloutTitle>
        </Callout>
        <DescriptionList>
          <DescriptionTerm>Term</DescriptionTerm>
        </DescriptionList>
      </>,
    );
    const overlays: string[] = [];
    for (const overlay of [
      <Dialog open key="dialog">
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
      <Sheet open key="sheet">
        <SheetContent>
          <SheetTitle>Sheet</SheetTitle>
        </SheetContent>
      </Sheet>,
    ]) {
      await withClient(overlay, async (view) => {
        const title = view.document.querySelector('[data-slot$="-title"]');
        overlays.push(`${title?.tagName} ${title?.textContent}`);
      });
    }
    const page = [...doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6, dt")].map(
      (node) => `${node.tagName} ${node.textContent}`,
    );
    expect([...page, ...overlays]).toEqual([
      "H1 Heading",
      "H2 Heading level 2",
      "H2 Subheading",
      "H3 Subheading level 3",
      "H4 Card",
      "H4 Empty",
      "H4 Callout",
      "DT Term",
      "H2 Dialog",
      "H2 Sheet",
    ]);
  });
});
