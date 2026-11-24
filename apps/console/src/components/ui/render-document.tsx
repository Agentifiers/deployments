import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";

export async function renderDocument(ui: ReactNode): Promise<Document> {
  const router = createRouter({
    history: createMemoryHistory(),
    routeTree: createRootRoute({ component: () => ui }),
  });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  return new JSDOM(html).window.document;
}
