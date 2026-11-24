import { createHash } from "node:crypto";
import dagre from "@dagrejs/dagre";
import { parseHTML } from "linkedom";

const MAX_MERMAID_DIAGRAM_NODES = 200;
const MAX_MERMAID_DIAGRAM_EDGES = 400;

const MERMAID_NODE_TYPE = new Map(
  (
    [
      ["circle", "circ circle"],
      ["diamond", "decision diam diamond question"],
      ["ellipse", "ellipse"],
      ["rect", "proc process rect rectangle square"],
      ["rounded", "event round rounded"],
      ["stadium", "pill stadium terminal"],
    ] as const
  ).flatMap(([type, aliases]) => aliases.split(" ").map((alias) => [alias, type] as const)),
);

export interface MermaidDiagramOptions {
  readonly definition: string;
  readonly fontSize: number;
  readonly style: "clean" | "sketchy";
  readonly theme: "dark" | "light";
  readonly title?: string;
}

interface MermaidVertex {
  readonly icon?: string;
  readonly id: string;
  readonly img?: string;
  readonly labelType?: string;
  readonly text?: unknown;
  readonly type?: string;
}

interface MermaidEdge {
  readonly end: string;
  readonly id?: string;
  readonly labelType?: string;
  readonly start: string;
  readonly stroke?: string;
  readonly text?: unknown;
  readonly type?: string;
}

/** The subset of Mermaid's internal `FlowDB` that flowchart conversion reads. */
interface MermaidFlowchartDatabase {
  getDirection(): string | undefined;
  getEdges(): MermaidEdge[];
  getSubGraphs?(): unknown[];
  getVertices(): Map<string, MermaidVertex> | Readonly<Record<string, MermaidVertex>>;
}

function isFlowchartDatabase(db: object): db is MermaidFlowchartDatabase {
  return ["getDirection", "getEdges", "getVertices"].every(
    (method) => typeof Reflect.get(db, method) === "function",
  );
}

interface DiagramNode {
  readonly height: number;
  readonly id: string;
  readonly label: string;
  readonly originalLabel: string;
  readonly shape: "diamond" | "ellipse" | "rectangle";
  readonly width: number;
  readonly rounded: boolean;
}

interface ExcalidrawScene {
  readonly appState: Readonly<Record<string, unknown>>;
  readonly elements: readonly Readonly<Record<string, unknown>>[];
  readonly files: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly type: "excalidraw";
  readonly version: 2;
}

const MERMAID_CONFIG = {
  maxEdges: MAX_MERMAID_DIAGRAM_EDGES + 1,
  maxTextSize: 100_000,
  securityLevel: "strict",
  startOnLoad: false,
} as const;

let mermaidDom: ReturnType<typeof parseHTML>;
let mermaidParser: Promise<(typeof import("mermaid"))["default"]> | undefined;
let parserQueue: Promise<unknown> = Promise.resolve();

function ensureMermaidDom() {
  if (mermaidDom) return;
  mermaidDom = parseHTML("<!doctype html><html><body></body></html>");
}

function installMermaidGlobals() {
  ensureMermaidDom();
  const { window } = mermaidDom!;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    DOMParser: window.DOMParser,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    SVGElement: window.SVGElement,
    document: window.document,
    window,
  })) {
    if (Reflect.get(globalThis, name) === undefined) {
      previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value,
        writable: true,
      });
    }
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

async function loadMermaidParser() {
  if (!mermaidParser) {
    const restoreGlobals = installMermaidGlobals();
    mermaidParser = import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize(MERMAID_CONFIG);
        return mermaid;
      })
      .finally(restoreGlobals);
  }
  return mermaidParser;
}

function runParserTask<T>(task: () => Promise<T>): Promise<T> {
  const result = parserQueue.then(task, task);
  parserQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function labelText(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value !== "string") return "";
  ensureMermaidDom();
  const decodedEntities = value
    .replaceAll("ﬂ°°", "#")
    .replaceAll("ﬂ°", "&")
    .replaceAll("¶ß", ";")
    .replaceAll(/#(\d+);/gu, "&#$1;")
    .replaceAll(/#([a-z]+);/gu, "&$1;");
  const textarea = mermaidDom!.document.createElement("textarea");
  textarea.innerHTML = decodedEntities;
  const container = mermaidDom!.document.createElement("div");
  container.innerHTML = textarea.value.replaceAll(/<br\s*\/?\s*>/giu, "\n");
  return (container.textContent ?? "")
    .replaceAll("\u00a0", " ")
    .replaceAll(/\r\n?|\n/gu, "\n")
    .trim();
}

function wrapLine(line: string, maximumCharacters: number): string[] {
  const words = line.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const chunks: string[] = [];
    const characters = Array.from(word);
    for (let index = 0; index < characters.length; index += maximumCharacters) {
      chunks.push(characters.slice(index, index + maximumCharacters).join(""));
    }
    for (const chunk of chunks) {
      const candidate = current ? `${current} ${chunk}` : chunk;
      if (Array.from(candidate).length <= maximumCharacters) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function wrapLabel(label: string, fontSize: number, maximumWidth = 340) {
  const maximumCharacters = Math.max(1, Math.floor(maximumWidth / fontSize));
  return label
    .split("\n")
    .flatMap((line) => wrapLine(line, maximumCharacters))
    .join("\n");
}

function diagramNodes(db: MermaidFlowchartDatabase, fontSize: number): DiagramNode[] {
  const raw = db.getVertices();
  const vertices = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
  if (vertices.length === 0) throw new TypeError("The Mermaid flowchart must contain a node.");
  if (vertices.length > MAX_MERMAID_DIAGRAM_NODES) {
    throw new TypeError(
      `Mermaid flowcharts must contain at most ${MAX_MERMAID_DIAGRAM_NODES} nodes.`,
    );
  }
  return vertices.map(([id, vertex]) => {
    if (vertex.labelType === "markdown") {
      throw new TypeError("Mermaid Markdown node labels are not supported.");
    }
    if (vertex.img !== undefined || vertex.icon !== undefined) {
      throw new TypeError("Mermaid image and icon nodes are not supported.");
    }
    const originalLabel =
      vertex.text === undefined || vertex.text === null ? id : labelText(vertex.text);
    const label = wrapLabel(originalLabel, fontSize);
    const lines = label.split("\n");
    const longestLine = Math.max(...lines.map((line) => Array.from(line).length), 1);
    const textWidth = longestLine * fontSize;
    const textHeight = lines.length * fontSize * 1.25;
    const rawType = vertex.type ?? "square";
    const type = MERMAID_NODE_TYPE.get(rawType);
    if (!type) {
      throw new TypeError(
        `Mermaid node type ${rawType} is not supported by editable Excalidraw output.`,
      );
    }
    const shape = ["circle", "ellipse"].includes(type)
      ? "ellipse"
      : ["diamond", "question"].includes(type)
        ? "diamond"
        : "rectangle";
    let height = Math.max(shape === "diamond" ? 100 : 64, textHeight + 40);
    let width = Math.min(420, Math.max(shape === "diamond" ? 140 : 120, textWidth + 80));
    if (shape !== "rectangle") {
      height = Math.max(height, Math.ceil((textHeight + 20) * 2.5));
      width = Math.max(width, Math.ceil((textWidth + 20) * 2.5));
    }
    if (type === "circle") height = width = Math.max(height, width);
    return {
      height,
      id,
      label,
      originalLabel,
      rounded: ["round", "rounded", "stadium"].includes(type),
      shape,
      width,
    };
  });
}

function rankDirection(value: string) {
  if (value === "TD") return "TB";
  return ["BT", "LR", "RL", "TB"].includes(value) ? value : "TB";
}

function hashInteger(value: string) {
  const integer = createHash("sha256").update(value).digest().readUInt32BE(0);
  return Math.max(1, integer & 0x7fffffff);
}

function elementIdentity(sceneHash: string, key: string) {
  const digest = createHash("sha256").update(`${sceneHash}:${key}`).digest("hex");
  return {
    id: digest.slice(0, 20),
    seed: hashInteger(`${digest}:seed`),
    versionNonce: hashInteger(`${digest}:version`),
  };
}

function baseElement(
  sceneHash: string,
  key: string,
  geometry: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  },
) {
  return {
    ...elementIdentity(sceneHash, key),
    ...geometry,
    angle: 0,
    boundElements: null,
    frameId: null,
    groupIds: [],
    isDeleted: false,
    link: null,
    locked: false,
    opacity: 100,
    updated: 1,
    version: 1,
  };
}

function textGeometry(label: string, fontSize: number, centerX: number, centerY: number) {
  const lines = label.split("\n");
  const width = Math.max(
    1,
    Math.max(...lines.map((line) => Array.from(line).length), 1) * fontSize,
  );
  const height = Math.max(fontSize * 1.25, lines.length * fontSize * 1.25);
  return { height, width, x: centerX - width / 2, y: centerY - height / 2 };
}

function sceneTheme(theme: MermaidDiagramOptions["theme"]) {
  return theme === "dark"
    ? {
        background: "#111827",
        fill: "#1e3a5f",
        label: "#f9fafb",
        stroke: "#e5e7eb",
      }
    : {
        background: "#ffffff",
        fill: "#dbeafe",
        label: "#1f2937",
        stroke: "#1f2937",
      };
}

function shapeElement(options: {
  readonly boundElements: readonly Readonly<Record<string, unknown>>[];
  readonly node: DiagramNode;
  readonly sceneHash: string;
  readonly style: MermaidDiagramOptions["style"];
  readonly theme: ReturnType<typeof sceneTheme>;
  readonly x: number;
  readonly y: number;
}) {
  return {
    ...baseElement(options.sceneHash, `node:${options.node.id}`, {
      height: options.node.height,
      width: options.node.width,
      x: options.x,
      y: options.y,
    }),
    backgroundColor: options.theme.fill,
    boundElements: options.boundElements,
    customData: { mermaidId: options.node.id },
    fillStyle: options.style === "clean" ? "solid" : "hachure",
    roughness: options.style === "clean" ? 0 : 1,
    roundness: options.node.shape === "rectangle" && options.node.rounded ? { type: 3 } : null,
    strokeColor: options.theme.stroke,
    strokeStyle: "solid",
    strokeWidth: 2,
    type: options.node.shape,
  };
}

function textElement(options: {
  readonly centerX: number;
  readonly centerY: number;
  readonly fontSize: number;
  readonly key: string;
  readonly label: string;
  readonly originalLabel?: string;
  readonly containerId?: string;
  readonly sceneHash: string;
  readonly style: MermaidDiagramOptions["style"];
  readonly theme: ReturnType<typeof sceneTheme>;
}) {
  return {
    ...baseElement(
      options.sceneHash,
      options.key,
      textGeometry(options.label, options.fontSize, options.centerX, options.centerY),
    ),
    autoResize: true,
    backgroundColor: "transparent",
    containerId: options.containerId ?? null,
    fillStyle: "solid",
    fontFamily: options.style === "clean" ? 2 : 1,
    fontSize: options.fontSize,
    lineHeight: 1.25,
    originalText: options.originalLabel ?? options.label,
    roughness: 0,
    roundness: null,
    strokeColor: options.theme.label,
    strokeStyle: "solid",
    strokeWidth: 1,
    text: options.label,
    textAlign: "center",
    type: "text",
    verticalAlign: "middle",
  };
}

function arrowElement(options: {
  readonly edge: MermaidEdge;
  readonly label: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly key: string;
  readonly sceneHash: string;
  readonly style: MermaidDiagramOptions["style"];
  readonly theme: ReturnType<typeof sceneTheme>;
}) {
  const minimumX = Math.min(...options.points.map(({ x }) => x));
  const minimumY = Math.min(...options.points.map(({ y }) => y));
  const maximumX = Math.max(...options.points.map(({ x }) => x));
  const maximumY = Math.max(...options.points.map(({ y }) => y));
  const firstPoint = options.points[0]!;
  const localPoints = options.points.map(({ x, y }) => [x - firstPoint.x, y - firstPoint.y]);
  const arrowheads =
    options.edge.type === "arrow_open"
      ? { end: null, start: null }
      : options.edge.type === "arrow_circle"
        ? { end: "circle", start: null }
        : options.edge.type === "double_arrow_circle"
          ? { end: "circle", start: "circle" }
          : options.edge.type === "double_arrow_point"
            ? { end: "arrow", start: "arrow" }
            : { end: "arrow", start: null };
  return {
    ...baseElement(options.sceneHash, `edge:${options.key}`, {
      height: maximumY - minimumY,
      width: maximumX - minimumX,
      x: firstPoint.x,
      y: firstPoint.y,
    }),
    backgroundColor: "transparent",
    boundElements: options.label
      ? [
          {
            id: elementIdentity(options.sceneHash, `edge-label:${options.key}`).id,
            type: "text",
          },
        ]
      : null,
    customData: { mermaidEdgeId: options.edge.id },
    elbowed: false,
    endArrowhead: arrowheads.end,
    endBinding: {
      elementId: elementIdentity(options.sceneHash, `node:${options.edge.end}`).id,
      focus: 0,
      gap: 1,
    },
    fillStyle: "solid",
    lastCommittedPoint: null,
    points: localPoints,
    roughness: options.style === "clean" ? 0 : 1,
    roundness: { type: 2 },
    startArrowhead: arrowheads.start,
    startBinding: {
      elementId: elementIdentity(options.sceneHash, `node:${options.edge.start}`).id,
      focus: 0,
      gap: 1,
    },
    strokeColor: options.theme.stroke,
    strokeStyle:
      options.edge.stroke === "dotted"
        ? "dotted"
        : options.edge.stroke === "thick"
          ? "solid"
          : "solid",
    strokeWidth: options.edge.stroke === "thick" ? 4 : 2,
    type: "arrow",
  };
}

function buildScene(
  nodes: readonly DiagramNode[],
  edges: readonly MermaidEdge[],
  direction: string,
  options: MermaidDiagramOptions,
): ExcalidrawScene {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    marginx: 60,
    marginy: 60,
    nodesep: 70,
    rankdir: rankDirection(direction),
    ranksep: 100,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const graphNodeKeyById = new Map(nodes.map((node, index) => [node.id, `node-${index}`] as const));
  for (const node of nodes) {
    graph.setNode(graphNodeKeyById.get(node.id)!, { height: node.height, width: node.width });
  }
  const edgeEntries = edges.map((edge, index) => ({
    edge,
    graphKey: `edge-${index}`,
    key: `${edge.id ?? `${edge.start}-${edge.end}`}:${index}`,
  }));
  edgeEntries.forEach(({ edge, graphKey, key }) => {
    const label = labelText(edge.text);
    const geometry = label
      ? textGeometry(
          wrapLabel(label, Math.max(12, options.fontSize - 2), 240),
          Math.max(12, options.fontSize - 2),
          0,
          0,
        )
      : { height: 0, width: 0 };
    graph.setEdge(
      graphNodeKeyById.get(edge.start)!,
      graphNodeKeyById.get(edge.end)!,
      {
        edge,
        height: geometry.height,
        key,
        label: wrapLabel(label, Math.max(12, options.fontSize - 2), 240),
        width: geometry.width,
      },
      graphKey,
    );
  });
  dagre.layout(graph);

  const sceneHash = createHash("sha256").update(JSON.stringify(options)).digest("hex");
  const theme = sceneTheme(options.theme);
  const elements: Readonly<Record<string, unknown>>[] = [];
  for (const node of nodes) {
    const position = graph.node(graphNodeKeyById.get(node.id)!) as {
      readonly x: number;
      readonly y: number;
    };
    const shapeId = elementIdentity(sceneHash, `node:${node.id}`).id;
    const boundElements = [
      ...(node.label
        ? [{ id: elementIdentity(sceneHash, `node-label:${node.id}`).id, type: "text" }]
        : []),
      ...edgeEntries
        .filter(
          ({ edge }) =>
            edge.stroke !== "invisible" && (edge.start === node.id || edge.end === node.id),
        )
        .map(({ key }) => ({
          id: elementIdentity(sceneHash, `edge:${key}`).id,
          type: "arrow",
        })),
    ];
    elements.push(
      shapeElement({
        boundElements,
        node,
        sceneHash,
        style: options.style,
        theme,
        x: position.x - node.width / 2,
        y: position.y - node.height / 2,
      }),
    );
    if (node.label) {
      elements.push(
        textElement({
          centerX: position.x,
          centerY: position.y,
          fontSize: options.fontSize,
          key: `node-label:${node.id}`,
          label: node.label,
          originalLabel: node.originalLabel,
          containerId: shapeId,
          sceneHash,
          style: options.style,
          theme,
        }),
      );
    }
  }
  for (const edgeKey of graph.edges()) {
    const layout = graph.edge(edgeKey) as {
      readonly edge: MermaidEdge;
      readonly key: string;
      readonly label: string;
      readonly points: readonly { readonly x: number; readonly y: number }[];
      readonly x?: number;
      readonly y?: number;
    };
    if (layout.points.length < 2) continue;
    if (layout.edge.stroke === "invisible") continue;
    elements.push(
      arrowElement({
        edge: layout.edge,
        key: layout.key,
        label: layout.label,
        points: layout.points,
        sceneHash,
        style: options.style,
        theme,
      }),
    );
    if (layout.label && layout.x !== undefined && layout.y !== undefined) {
      elements.push(
        textElement({
          centerX: layout.x,
          centerY: layout.y,
          fontSize: Math.max(12, options.fontSize - 2),
          key: `edge-label:${layout.key}`,
          label: layout.label,
          containerId: elementIdentity(sceneHash, `edge:${layout.key}`).id,
          sceneHash,
          style: options.style,
          theme,
        }),
      );
    }
  }
  if (options.title) {
    const bounds = graph.graph() as { readonly width?: number };
    elements.push(
      textElement({
        centerX: (bounds.width ?? 600) / 2,
        centerY: 24,
        fontSize: Math.min(48, options.fontSize + 8),
        key: "title",
        label: options.title,
        sceneHash,
        style: options.style,
        theme,
      }),
    );
  }
  return {
    appState: {
      currentItemFillStyle: options.style === "clean" ? "solid" : "hachure",
      currentItemRoughness: options.style === "clean" ? 0 : 1,
      gridSize: null,
      viewBackgroundColor: theme.background,
    },
    elements,
    files: {},
    source: "https://deployments.ai",
    type: "excalidraw",
    version: 2,
  };
}

async function parseFlowchart(definition: string, fontSize: number) {
  return runParserTask(async () => {
    const mermaid = await loadMermaidParser();
    let diagram: { readonly db: object; readonly type: string };
    try {
      diagram = await mermaid.mermaidAPI.getDiagramFromText(definition);
    } catch (cause) {
      throw new TypeError("The Mermaid definition could not be parsed.", { cause });
    }
    if (diagram.type !== "flowchart-v2" && diagram.type !== "graph") {
      throw new TypeError(
        `Mermaid diagram type ${diagram.type} is not supported; use a flowchart or graph definition.`,
      );
    }
    const { db } = diagram;
    if (!isFlowchartDatabase(db)) {
      throw new TypeError("The Mermaid flowchart database is not supported.");
    }
    const edges = db.getEdges();
    if (edges.some(({ labelType }) => labelType === "markdown")) {
      throw new TypeError("Mermaid Markdown edge labels are not supported.");
    }
    const unsupportedEdge = edges.find(
      ({ type }) =>
        type !== undefined &&
        ![
          "arrow_circle",
          "arrow_open",
          "arrow_point",
          "double_arrow_circle",
          "double_arrow_point",
        ].includes(type),
    );
    if (unsupportedEdge) {
      throw new TypeError(
        `Mermaid edge type ${unsupportedEdge.type} is not supported by editable Excalidraw output.`,
      );
    }
    const subGraphs = db.getSubGraphs?.() ?? [];
    if (subGraphs.length > 0) {
      throw new TypeError(
        "Mermaid subgraphs are not supported; use a flowchart without subgraph blocks.",
      );
    }
    if (edges.length > MAX_MERMAID_DIAGRAM_EDGES) {
      throw new TypeError(
        `Mermaid flowcharts must contain at most ${MAX_MERMAID_DIAGRAM_EDGES} edges.`,
      );
    }
    const nodes = diagramNodes(db, fontSize);
    const nodeIds = new Set(nodes.map(({ id }) => id));
    if (edges.some(({ end, start }) => !nodeIds.has(start) || !nodeIds.has(end))) {
      throw new TypeError("The Mermaid flowchart contains an edge with an unsupported endpoint.");
    }
    return {
      direction: db.getDirection() ?? "TB",
      edges,
      nodes,
    };
  });
}

export async function mermaidToExcalidrawScene(
  options: MermaidDiagramOptions,
): Promise<ExcalidrawScene> {
  const parsed = await parseFlowchart(options.definition, options.fontSize);
  return buildScene(parsed.nodes, parsed.edges, parsed.direction, options);
}
