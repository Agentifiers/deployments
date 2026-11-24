import { describe, expect, test } from "bun:test";
import { Badge } from "@/components/ui/badge";
import { renderDocument } from "@/components/ui/render-document";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

describe("Table", () => {
  test("a row with href links every cell to it, labelled by the row title", async () => {
    const doc = await renderDocument(
      <Table dense striped>
        <TableBody>
          <TableRow href="/runs/run-1" title="Run run-1">
            <TableCell>run-1</TableCell>
            <TableCell>succeeded</TableCell>
          </TableRow>
          <TableRow title="Plain row">
            <TableCell>run-2</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const rows = [...doc.querySelectorAll("tr")];
    expect(
      rows.map((row) => ({
        title: row.getAttribute("title"),
        links: [...row.querySelectorAll("a")].map((link) => [
          link.getAttribute("href"),
          link.getAttribute("aria-label"),
        ]),
      })),
    ).toEqual([
      {
        title: null,
        links: [
          ["/runs/run-1", "Run run-1"],
          ["/runs/run-1", "Run run-1"],
        ],
      },
      { title: "Plain row", links: [] },
    ]);
    const table = doc.querySelector("table");
    expect([table?.getAttribute("data-dense"), table?.getAttribute("data-striped")]).toEqual([
      "true",
      "true",
    ]);
  });

  test("dense and striped reach cells and body rows, and only linked rows hover", async () => {
    const doc = await renderDocument(
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow href="/runs/run-1" title="Run run-1">
            <TableCell>run-1</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>run-2</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const names = (element: Element | null | undefined) => element?.className.split(" ") ?? [];
    const [header, linked, plain] = [...doc.querySelectorAll("tr")].map(names);
    const rowRules = (row: string[] = []) =>
      row.filter((name) => name.includes("striped") || name.includes("hover:"));
    expect({
      denseCell: names(doc.querySelector("td")).includes("group-data-dense/table:py-2"),
      headerBorder: header?.includes("border-b"),
      header: rowRules(header),
      linked: rowRules(linked),
      plain: rowRules(plain),
    }).toEqual({
      denseCell: true,
      headerBorder: true,
      header: ["[[data-striped]_tbody_&]:border-0", "[[data-striped]_tbody_&]:even:bg-muted/50"],
      linked: [
        "[[data-striped]_tbody_&]:border-0",
        "[[data-striped]_tbody_&]:even:bg-muted/50",
        "hover:bg-muted",
        "[[data-striped]_tbody_&]:even:hover:bg-muted",
      ],
      plain: ["[[data-striped]_tbody_&]:border-0", "[[data-striped]_tbody_&]:even:bg-muted/50"],
    });
  });

  test("a Badge in a linked row stays under the row link, so clicking it navigates", async () => {
    const doc = await renderDocument(
      <Table>
        <TableBody>
          <TableRow href="/runs/run-1" title="Run run-1">
            <TableCell>
              <Badge color="green">succeeded</Badge>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const overlay = doc.querySelector("a[data-row-link]")?.className.split(" ") ?? [];
    const badge = doc.querySelector('[data-slot="badge"]')?.className.split(" ") ?? [];
    const positioning = ["static", "relative", "absolute", "fixed", "sticky"];
    expect({
      overlay: overlay.filter((name) => positioning.includes(name) || name.startsWith("z-")),
      badge: badge.filter((name) => positioning.includes(name) || name.startsWith("z-")),
    }).toEqual({ overlay: ["absolute"], badge: ["static"] });
  });
});
