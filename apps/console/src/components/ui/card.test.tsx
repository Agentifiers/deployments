import { describe, expect, test } from "bun:test";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { renderDocument } from "@/components/ui/render-document";

describe("CardTitle", () => {
  test("is an h4 heading", async () => {
    const doc = await renderDocument(
      <Card size="sm">
        <CardHeader>
          <CardTitle>Deployments</CardTitle>
        </CardHeader>
      </Card>,
    );
    const title = doc.querySelector('[data-slot="card-title"]');
    expect([title?.tagName, title?.textContent]).toEqual(["H4", "Deployments"]);
  });
});
