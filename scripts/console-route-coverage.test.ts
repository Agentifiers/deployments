import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { checkProblems, scanRouteCalls } from "./console-route-coverage.ts";

async function tree(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), "console-coverage-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

describe("scanRouteCalls", () => {
  test("counts string-literal calls from server/ and flags everything else", async () => {
    const root = await tree({
      "data/widget-mutations.ts": `callRoute("archiveWidget", {}, token);`,
      "server/platform-api.ts": `export function callRoute(name) { return call(name); }`,
      "server/widget-actions.ts": [
        `callRoute("createWidget", { body }, token);`,
        `await callRouteOnce(`,
        `  'listWidgets',`,
        `  { scope },`,
        `);`,
        `hotPlane(\`getWidgetMetrics\`, input);`,
        `callRoute(operation, input, token);`,
        `const label = "updateWidget";`,
        `callRoute(\`${"$"}{prefix}Widget\`, input, token);`,
      ].join("\n"),
      "server/widget-actions.test.ts": `callRoute("deleteWidget", {}, token);`,
    });
    const scan = await scanRouteCalls(root);
    expect({ ...scan, called: [...scan.called].sort() }).toEqual({
      called: ["createWidget", "getWidgetMetrics", "listWidgets"],
      outsideServer: [{ callee: "callRoute", file: "data/widget-mutations.ts", line: 1 }],
      unresolved: [
        { callee: "callRoute", file: "server/widget-actions.ts", line: 7 },
        { callee: "callRoute", file: "server/widget-actions.ts", line: 9 },
      ],
      unreached: [],
    });
  });

  test("reads generic and `as const` calls and ignores calls inside comments", async () => {
    const root = await tree({
      "server/widget-actions.ts": [
        `callRoute<"getWidget">("getWidget", input, token);`,
        `callRoute<RouteName<"x">>(operation, input, token);`,
        `callRoute("renameWidget" as const, input, token);`,
        `// callRoute("commentedWidget", {}, token);`,
        `/* callRoute(operation, input, token); */`,
        `/**`,
        ` * callRoute("documentedWidget", {}, token)`,
        ` * callRoute(name)`,
        ` */`,
        `const url = "https://example.com"; callRoute("pingWidget", {}, token); // callRoute(x)`,
        `callRoute(operation, input, token);`,
      ].join("\n"),
      "data/widget-queries.ts": `// callRoute("listWidgets", {}, token);`,
    });
    const scan = await scanRouteCalls(root);
    expect({ ...scan, called: [...scan.called].sort() }).toEqual({
      called: ["getWidget", "pingWidget", "renameWidget"],
      outsideServer: [],
      unresolved: [
        { callee: "callRoute", file: "server/widget-actions.ts", line: 2 },
        { callee: "callRoute", file: "server/widget-actions.ts", line: 11 },
      ],
      unreached: [],
    });
  });

  test("counts calls through import aliases of callRoute and callRouteOnce", async () => {
    const root = await tree({
      "data/widget-mutations.ts": [
        `import { callRoute as send } from "../server/platform-api.ts";`,
        `send("archiveWidget", {}, token);`,
      ].join("\n"),
      "server/widget-actions.ts": [
        `import { callRoute as platformCallRoute, callRouteOnce as once } from "./platform-api.ts";`,
        `type CallRoute = typeof platformCallRoute;`,
        `const doc = \`import { callRoute as fake } from "./platform-api.ts"\`;`,
        `export async function save(`,
        `  callRoute:`,
        `    | CallRoute`,
        `    | undefined = platformCallRoute,`,
        `) {`,
        `  await platformCallRoute("createWidget", {}, token);`,
        `  await once<"listWidgets">('listWidgets', {});`,
        `  await callRoute?.("updateWidget", {}, token);`,
        `  await platformCallRoute(operation, {}, token);`,
        `  await callRoute!("renameWidget", {}, token);`,
        `  stream.once("close", handler);`,
        `  fake("deleteWidget", {}, token);`,
        `  await applySkillPlan({ callRoute: platformCallRoute, scope });`,
        `  return readWidget(deps.callRoute, platformCallRoute, token);`,
        `}`,
      ].join("\n"),
    });
    const scan = await scanRouteCalls(root);
    expect({ ...scan, called: [...scan.called].sort() }).toEqual({
      called: ["createWidget", "listWidgets", "renameWidget", "updateWidget"],
      outsideServer: [{ callee: "send", file: "data/widget-mutations.ts", line: 2 }],
      unresolved: [{ callee: "platformCallRoute", file: "server/widget-actions.ts", line: 12 }],
      unreached: [],
    });
  });

  test("does not count a call written inside a string or template literal", async () => {
    const root = await tree({
      "server/widget-actions.ts": [
        `const hint = 'retry with callRoute("createTenantErasure", {}, token)';`,
        `const query = \`id=${"$"}{(await callRoute("listManagedSkills", {}, token)).id}\`;`,
      ].join("\n"),
    });
    const scan = await scanRouteCalls(root);
    expect({ ...scan, called: [...scan.called] }).toEqual({
      called: [],
      outsideServer: [],
      unresolved: [],
      unreached: [
        { file: "server/widget-actions.ts", line: 1, name: "createTenantErasure" },
        { file: "server/widget-actions.ts", line: 2, name: "listManagedSkills" },
      ],
    });
  });

  test("still flags calls the lexer misreads as literal text", async () => {
    const root = await tree({
      "components/notice.tsx": [
        `import { callRoute } from "../server/platform-api.ts";`,
        `export const Notice = ({ t }) => <p>Don't {String(callRoute("archiveBrain", {}, t))} it's</p>;`,
      ].join("\n"),
      "server/widget-actions.ts": [
        `import { callRoute } from "./platform-api.ts";`,
        `export const f = (op, t, s) => s.replace(/'/g, "") && callRoute(op, {}, t) && s.endsWith("'");`,
      ].join("\n"),
    });
    const { outsideServer, unresolved } = await scanRouteCalls(root);
    expect({ outsideServer, unresolved }).toEqual({
      outsideServer: [{ callee: "callRoute", file: "components/notice.tsx", line: 2 }],
      unresolved: [{ callee: "callRoute", file: "server/widget-actions.ts", line: 2 }],
    });
  });

  test("fails --check when server/ names an operation no counted call reaches", async () => {
    const root = await tree({
      "routes/widgets.tsx": `const operation = "createTenantDataExport";`,
      "server/widget-actions.ts": [
        `import { callRoute as platformCallRoute } from "./platform-api.ts";`,
        `const send = platformCallRoute;`,
        `await send("listManagedSkills", {}, token);`,
        `await (platformCallRoute)("createTenantErasure", {}, token);`,
        `const { callRoute: Send } = api;`,
        `await Send('createTenantDataExport', {}, token);`,
        `await withRetry(platformCallRoute)(\`createImmutableAuditExport\`, {}, token);`,
        `type Placement = RouteResponse<"getAgentEmailPlacement">;`,
        `await platformCallRoute("listManagedSkillSources", {}, token);`,
        `const sources = ["listManagedSkillSources", "notAnOperation"];`,
      ].join("\n"),
    });
    expect(checkProblems(await scanRouteCalls(root))).toEqual([
      "server/widget-actions.ts:3 names listManagedSkills but no counted call reaches it",
      "server/widget-actions.ts:4 names createTenantErasure but no counted call reaches it",
      "server/widget-actions.ts:6 names createTenantDataExport but no counted call reaches it",
      "server/widget-actions.ts:7 names createImmutableAuditExport but no counted call reaches it",
    ]);
  });

  test("the console calls every operation through a literal name from server/", async () => {
    const scan = await scanRouteCalls(path.join(import.meta.dir, "../apps/console/src"));
    expect(checkProblems(scan)).toEqual([]);
  });
});
