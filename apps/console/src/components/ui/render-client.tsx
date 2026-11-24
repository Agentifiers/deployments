import { mock } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Base UI picks its layout-effect hook once, when first imported. Any import of Base UI before
// withClient installs `document` (a test file's own static imports, or an earlier file in bun
// test's shared module registry) leaves a no-op behind, and Dialog and Sheet never mount. Bun
// patches a mocked module in place only once it is loaded, and Base UI resolves it from its own
// directory, hence the runtime path.
const isoLayoutEffect = Bun.resolveSync(
  "@base-ui/utils/useIsoLayoutEffect",
  Bun.resolveSync("@base-ui/react/dialog", import.meta.dir),
);
await import(isoLayoutEffect);
// oxlint-disable-next-line no-restricted-properties -- every console test wants this patch, so it may outlive the file
await mock.module(isoLayoutEffect, () => ({ useIsoLayoutEffect: useLayoutEffect }));

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "history",
  "Node",
  "Text",
  "Element",
  "HTMLElement",
  "SVGElement",
  "DocumentFragment",
  "ShadowRoot",
  "Event",
  "CustomEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "getComputedStyle",
] as const;

// jsdom has no requestAnimationFrame, and Base UI's frame scheduler is process-global, so frames
// run on the process timer rather than on a window that a later test closes.
const frames = {
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};

export type ClientView = {
  document: Document;
  click: (element: Element | null | undefined) => Promise<void>;
  press: (key: string) => Promise<void>;
};

export async function withClient(ui: ReactNode, run: (view: ClientView) => Promise<void>) {
  const { window } = new JSDOM("<!doctype html><body></body>", { url: "https://console.test/" });
  Object.assign(window, frames);
  // react-dom loads before `document` exists here, so it falls back to IE's input-event
  // polyfill, which calls attachEvent once focus enters an input, as a dialog's initial focus does.
  Object.assign(window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  const installed = [
    ...GLOBALS,
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const saved = installed.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  for (const key of installed) {
    Reflect.set(globalThis, key, key === "IS_REACT_ACT_ENVIRONMENT" ? true : window[key]);
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")));
  try {
    const settle = () => act(() => new Promise<void>((resolve) => window.setTimeout(resolve, 50)));
    await act(async () => root.render(ui));
    await settle();
    await run({
      document: window.document,
      click: async (element) => {
        if (!element) throw new Error("click target not found");
        await act(async () => {
          element.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
          element.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
          element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        });
        await settle();
      },
      press: async (key) => {
        await act(async () => {
          const target = window.document.activeElement ?? window.document.body;
          target.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key }));
        });
        await settle();
      },
    });
  } finally {
    await act(async () => root.unmount());
    installed.forEach((key, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
    window.close();
  }
}
