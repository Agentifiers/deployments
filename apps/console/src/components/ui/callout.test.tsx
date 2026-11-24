import { describe, expect, test } from "bun:test";
import { Callout, CalloutAction, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { renderDocument } from "@/components/ui/render-document";

const classes = (element: Element | null | undefined) => element?.className.split(" ") ?? [];

describe("Callout", () => {
  test("announces destructive callouts as alerts and the rest as status", async () => {
    const doc = await renderDocument(
      <>
        <Callout>Default</Callout>
        <Callout variant="info">Info</Callout>
        <Callout variant="success">Success</Callout>
        <Callout variant="warning">Warning</Callout>
        <Callout variant="destructive">Destructive</Callout>
      </>,
    );
    expect(
      [...doc.querySelectorAll('[data-slot="alert"]')].map((node) => [
        node.textContent,
        node.getAttribute("role"),
      ]),
    ).toEqual([
      ["Default", "status"],
      ["Info", "status"],
      ["Success", "status"],
      ["Warning", "status"],
      ["Destructive", "alert"],
    ]);
  });

  test("titles are wrapping h4 headings and descriptions flow as a block", async () => {
    const doc = await renderDocument(
      <Callout>
        <CalloutTitle>A long title</CalloutTitle>
        <CalloutDescription>
          Run <code>deployments skills release</code> again.
        </CalloutDescription>
        <CalloutAction>Retry</CalloutAction>
      </Callout>,
    );
    const title = doc.querySelector('[data-slot="alert-title"]');
    const description = classes(doc.querySelector('[data-slot="alert-description"]'));
    expect({
      title: [
        title?.tagName,
        classes(title).some((name) => name.startsWith("line-clamp")),
        classes(title).filter((name) => name.startsWith("font-")),
      ],
      description: [description.includes("block"), description.includes("grid")],
      action: classes(doc.querySelector('[data-slot="alert-action"]')).includes("sm:pl-3"),
    }).toEqual({
      title: ["H4", false, ["font-semibold"]],
      description: [true, false],
      action: true,
    });
  });

  test("destructive callouts color their title and description but not their actions, and warning and success darken their icons", async () => {
    const doc = await renderDocument(
      <>
        <Callout variant="destructive">
          <CalloutTitle>Authorization failed</CalloutTitle>
          <CalloutDescription>Failed</CalloutDescription>
          <CalloutAction>Try again</CalloutAction>
        </Callout>
        <Callout variant="warning">Warning</Callout>
        <Callout variant="success">Success</Callout>
        <Callout variant="info">Info</Callout>
      </>,
    );
    const [destructive, ...rest] = doc.querySelectorAll('[data-slot="alert"]');
    const tone = "group-data-[variant=destructive]/callout:text-destructive";
    expect({
      root: [
        destructive?.getAttribute("data-variant"),
        classes(destructive).includes("group/callout"),
        classes(destructive).includes("text-destructive"),
      ],
      parts: ["alert-title", "alert-description", "alert-action"].map((slot) =>
        classes(destructive?.querySelector(`[data-slot="${slot}"]`)).includes(tone),
      ),
      icons: rest.map((node) => classes(node).filter((name) => name.startsWith("[&>svg]:text-"))),
    }).toEqual({
      root: ["destructive", true, false],
      parts: [true, true, false],
      icons: [
        ["[&>svg]:text-warning-foreground"],
        ["[&>svg]:text-success-foreground"],
        ["[&>svg]:text-info"],
      ],
    });
  });
});
