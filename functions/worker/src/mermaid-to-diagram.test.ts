import { describe, expect, test } from "bun:test";
import { mermaidToExcalidrawScene } from "./mermaid-to-diagram.ts";

const FLOWCHART = `flowchart LR
  receive[Receive request] --> valid{Valid?}
  valid -->|Yes| process((Process))
  valid -.->|No| reject[Reject]`;

function elementsOfType(scene: Awaited<ReturnType<typeof mermaidToExcalidrawScene>>, type: string) {
  return scene.elements.filter((element) => element.type === type);
}

describe("Mermaid to Excalidraw conversion", () => {
  test("restores temporary Mermaid DOM globals after parser initialization", async () => {
    const globals = globalThis as unknown as Readonly<Record<string, unknown>>;
    const previous = {
      document: globals.document,
      Element: globals.Element,
      window: globals.window,
    };
    await mermaidToExcalidrawScene({
      definition: "flowchart TD\nA[One] --> B[Two]",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect({
      document: globals.document,
      Element: globals.Element,
      window: globals.window,
    }).toEqual(previous);
  });

  test("builds editable shapes, routed arrows, and labels", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: FLOWCHART,
      fontSize: 20,
      style: "clean",
      theme: "light",
      title: "Request flow",
    });

    expect(scene).toMatchObject({
      appState: { currentItemRoughness: 0, viewBackgroundColor: "#ffffff" },
      files: {},
      type: "excalidraw",
      version: 2,
    });
    expect(scene.elements.every((element) => element.index === undefined)).toBe(true);
    expect(elementsOfType(scene, "rectangle")).toHaveLength(2);
    expect(elementsOfType(scene, "diamond")).toHaveLength(1);
    expect(elementsOfType(scene, "ellipse")).toHaveLength(1);
    expect(elementsOfType(scene, "arrow")).toHaveLength(3);
    expect(elementsOfType(scene, "text").map(({ text }) => text)).toEqual(
      expect.arrayContaining([
        "Receive request",
        "Valid?",
        "Process",
        "Reject",
        "Yes",
        "No",
        "Request flow",
      ]),
    );
    expect(
      elementsOfType(scene, "arrow").every(
        ({ points }) => Array.isArray(points) && points.length >= 2,
      ),
    ).toBe(true);
    expect(
      elementsOfType(scene, "arrow").every(
        ({ points }) => JSON.stringify((points as readonly unknown[])[0]) === "[0,0]",
      ),
    ).toBe(true);
    const shapes = scene.elements.filter((element) =>
      ["diamond", "ellipse", "rectangle"].includes(String(element.type)),
    );
    const shapeIds = new Set(shapes.map(({ id }) => id));
    const arrowIds = new Set(elementsOfType(scene, "arrow").map(({ id }) => id));
    expect(
      shapes.every(({ boundElements }) =>
        (boundElements as readonly Readonly<Record<string, unknown>>[]).some(
          ({ type }) => type === "text",
        ),
      ),
    ).toBe(true);
    expect(
      scene.elements
        .filter(({ containerId }) => containerId !== undefined && containerId !== null)
        .every(({ containerId }) => shapeIds.has(containerId) || arrowIds.has(containerId)),
    ).toBe(true);
    expect(
      scene.elements
        .filter(({ text }) => text === "Yes" || text === "No")
        .every(({ containerId }) => arrowIds.has(containerId)),
    ).toBe(true);
    expect(
      elementsOfType(scene, "arrow").every(
        ({ endBinding, startBinding }) =>
          shapeIds.has((startBinding as { readonly elementId: unknown }).elementId) &&
          shapeIds.has((endBinding as { readonly elementId: unknown }).elementId),
      ),
    ).toBe(true);
  });

  test("maps style and theme options onto every editable element", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: "flowchart TD\nA[One] --> B[Two]",
      fontSize: 24,
      style: "sketchy",
      theme: "dark",
    });
    const shapes = scene.elements.filter((element) =>
      ["diamond", "ellipse", "rectangle"].includes(String(element.type)),
    );
    const labels = elementsOfType(scene, "text");
    expect(scene.appState).toMatchObject({
      currentItemFillStyle: "hachure",
      currentItemRoughness: 1,
      viewBackgroundColor: "#111827",
    });
    expect(
      shapes.every(({ fillStyle, roughness }) => fillStyle === "hachure" && roughness === 1),
    ).toBe(true);
    expect(labels.every(({ fontFamily, fontSize }) => fontFamily === 1 && fontSize === 24)).toBe(
      true,
    );
  });

  test("preserves rounded nodes and circle edge markers", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: "flowchart LR\nA(Rounded) o--o B([Stadium])",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    const rounded = elementsOfType(scene, "rectangle").find(
      ({ customData }) => (customData as { readonly mermaidId?: string }).mermaidId === "A",
    );
    const stadium = elementsOfType(scene, "rectangle").find(
      ({ customData }) => (customData as { readonly mermaidId?: string }).mermaidId === "B",
    );
    const arrow = elementsOfType(scene, "arrow")[0];
    expect(rounded?.roundness).toEqual({ type: 3 });
    expect(stadium?.roundness).toEqual({ type: 3 });
    expect(arrow).toMatchObject({ endArrowhead: "circle", startArrowhead: "circle" });
  });

  test("normalizes supported Mermaid shape aliases", async () => {
    for (const [alias, elementType] of [
      ["diam", "diamond"],
      ["decision", "diamond"],
      ["process", "rectangle"],
      ["rectangle", "rectangle"],
      ["circ", "ellipse"],
      ["pill", "rectangle"],
    ] as const) {
      const scene = await mermaidToExcalidrawScene({
        definition: `flowchart TD\nA@{ shape: ${alias}, label: "Node" }`,
        fontSize: 20,
        style: "clean",
        theme: "light",
      });
      expect(scene.elements.some(({ type }) => type === elementType)).toBe(true);
    }
  });

  test("preserves explicitly empty node labels", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: 'flowchart TD\nA[" "]',
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect(elementsOfType(scene, "text")).toHaveLength(0);
    const shape = elementsOfType(scene, "rectangle")[0]!;
    expect(
      (shape.boundElements as readonly { type: string }[]).some(({ type }) => type === "text"),
    ).toBe(false);
  });

  test("is byte-stable for identical input", async () => {
    const options = {
      definition: FLOWCHART,
      fontSize: 18,
      style: "clean" as const,
      theme: "light" as const,
    };
    const first = await mermaidToExcalidrawScene(options);
    const second = await mermaidToExcalidrawScene(options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("wraps long labels inside their bound node", async () => {
    const originalLabel =
      "This deliberately long Mermaid label wraps within its editable Excalidraw container";
    const scene = await mermaidToExcalidrawScene({
      definition: `flowchart TD\nA[${originalLabel}]`,
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    const shape = elementsOfType(scene, "rectangle")[0]!;
    const label = elementsOfType(scene, "text")[0]!;
    expect(label.text).toContain("\n");
    expect(label.originalText).toBe(originalLabel);
    expect(Number(label.width)).toBeLessThan(Number(shape.width));
    expect(label.containerId).toBe(shape.id);
  });

  test("keeps wide glyph labels inside their bound node", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: `flowchart TD\nA[${"東京😀W".repeat(20)}]`,
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    const shape = elementsOfType(scene, "rectangle")[0]!;
    const label = elementsOfType(scene, "text")[0]!;
    expect(label.text).toContain("\n");
    expect(Number(label.width)).toBeLessThan(Number(shape.width));
  });

  test("keeps wrapped labels inside non-rectangular node boundaries", async () => {
    const longLabel =
      "A long decision label that wraps across several lines without crossing its outline";
    for (const [definition, elementType, boundaryValue] of [
      [`flowchart TD\nA{${longLabel}}`, "diamond", (x: number, y: number) => x + y],
      [`flowchart TD\nA((${longLabel}))`, "ellipse", (x: number, y: number) => x ** 2 + y ** 2],
    ] as const) {
      const scene = await mermaidToExcalidrawScene({
        definition,
        fontSize: 20,
        style: "clean",
        theme: "light",
      });
      const shape = elementsOfType(scene, elementType)[0]!;
      const label = elementsOfType(scene, "text")[0]!;
      const normalizedX = Number(label.width) / Number(shape.width);
      const normalizedY = Number(label.height) / Number(shape.height);
      expect(boundaryValue(normalizedX, normalizedY)).toBeLessThanOrEqual(0.8);
    }
  });

  test("decodes Mermaid entity placeholders in node and edge labels", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: "flowchart LR\nA[AT#38;T] -->|Cost #36;5| B[Done]",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect(elementsOfType(scene, "text").map(({ text }) => text)).toEqual(
      expect.arrayContaining(["AT&T", "Cost $5"]),
    );
  });

  test("uses invisible Mermaid links for layout without drawing them", async () => {
    const scene = await mermaidToExcalidrawScene({
      definition: "flowchart LR\nA[One] ~~~ B[Two]",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect(elementsOfType(scene, "rectangle")).toHaveLength(2);
    expect(elementsOfType(scene, "arrow")).toHaveLength(0);
  });

  test("anchors reverse-direction arrows at their first endpoint", async () => {
    for (const direction of ["BT", "RL"]) {
      const scene = await mermaidToExcalidrawScene({
        definition: `flowchart ${direction}\nA[One] --> B[Two]`,
        fontSize: 20,
        style: "clean",
        theme: "light",
      });
      const points = elementsOfType(scene, "arrow")[0]?.points as readonly unknown[];
      expect(points[0]).toEqual([0, 0]);
    }
  });

  test("isolates prototype-like Mermaid IDs from Graphlib storage", async () => {
    const originalAssign = Object.assign;
    const scene = await mermaidToExcalidrawScene({
      definition: "flowchart TD\nconstructor --> assign",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect(Object.assign).toBe(originalAssign);
    expect(elementsOfType(scene, "rectangle")).toHaveLength(2);
    expect(elementsOfType(scene, "arrow")).toHaveLength(1);
    const next = await mermaidToExcalidrawScene({
      definition: "flowchart TD\nA[Safe] --> B[Still safe]",
      fontSize: 20,
      style: "clean",
      theme: "light",
    });
    expect(elementsOfType(next, "arrow")).toHaveLength(1);
  });

  test("rejects edge counts above the rendering budget without truncating", async () => {
    expect(
      mermaidToExcalidrawScene({
        definition: `flowchart LR\n${Array.from({ length: 401 }, () => "A --> B").join("\n")}`,
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("at most 400 edges");
  });

  test("rejects image and icon nodes instead of silently discarding their decorations", async () => {
    for (const definition of [
      'flowchart TD\nA@{ img: "https://example.com/photo.png", label: "Photo" }',
      'flowchart TD\nA@{ icon: "fa:user", label: "User" }',
    ]) {
      expect(
        mermaidToExcalidrawScene({
          definition,
          fontSize: 20,
          style: "clean",
          theme: "light",
        }),
      ).rejects.toThrow("image and icon nodes are not supported");
    }
  });

  test("rejects malformed definitions and non-flowchart diagrams", async () => {
    expect(
      mermaidToExcalidrawScene({
        definition: "flowchart TD\nA -->",
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("could not be parsed");
    expect(
      mermaidToExcalidrawScene({
        definition: "sequenceDiagram\nAlice->>Bob: Hello",
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("use a flowchart or graph");
    expect(
      mermaidToExcalidrawScene({
        definition: "flowchart TD\nsubgraph Group\nA[One] --> B[Two]\nend",
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("subgraphs are not supported");
    expect(
      mermaidToExcalidrawScene({
        definition: "flowchart LR\nA[One] --x B[Two]",
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("edge type arrow_cross is not supported");
    expect(
      mermaidToExcalidrawScene({
        definition: "flowchart LR\nA[(Database)] --> B(((Double circle)))",
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("node type cylinder is not supported");
    expect(
      mermaidToExcalidrawScene({
        definition: 'flowchart TD\nA["`**Ready**`"]',
        fontSize: 20,
        style: "clean",
        theme: "light",
      }),
    ).rejects.toThrow("Markdown node labels are not supported");
  });
});
