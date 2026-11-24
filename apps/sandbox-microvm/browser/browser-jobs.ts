import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ScreenshotOptions } from "puppeteer-core";
import {
  openGuardedPage,
  remainingTimeout,
  settleAfterBrowserAction,
  waitForVisibleSelector,
  withDeadline,
  type GuardedPage,
} from "./chromium-page.ts";
import {
  BrowserJobFailure,
  MAX_SESSION_DOM_BYTES,
  MAX_SESSION_TITLE_BYTES,
  assertImageSize,
  assertRenderBounds,
  isAllowedNavigation,
  truncateUtf8,
  type CaptureInput,
  type NavigationTargets,
  type SessionAction,
  type SessionInput,
} from "./job-rules.ts";

interface BrowserJobContext {
  readonly targets: NavigationTargets;
  readonly jobDirectory: string;
  readonly registerEmergencyCleanup: (cleanup: () => void) => void;
}

async function withGuardedPage<T>(
  context: BrowserJobContext,
  input: Pick<CaptureInput, "timeoutMs" | "viewportSize">,
  operation: (guarded: GuardedPage) => Promise<T>,
) {
  const guarded = await openGuardedPage({
    registerEmergencyCleanup: context.registerEmergencyCleanup,
    targets: context.targets,
    timeoutMs: input.timeoutMs,
    viewportSize: input.viewportSize,
  });
  try {
    return await operation(guarded);
  } finally {
    await guarded.close();
  }
}

const FULL_PAGE_BOUNDS_EXPRESSION = `(() => {
  const root = document.documentElement;
  const body = document.body;
  return {
    height: Math.max(root.scrollHeight, root.clientHeight, body?.scrollHeight ?? 0),
    width: Math.max(root.scrollWidth, root.clientWidth, body?.scrollWidth ?? 0),
  };
})()`;

async function captureBytes(guarded: GuardedPage, input: CaptureInput, deadline: number) {
  const { page } = guarded;
  const screenshotOptions: ScreenshotOptions = {
    encoding: "binary",
    type: input.format,
    ...(input.format === "png" ? {} : { quality: 100 }),
  };
  if (input.selector) {
    const element = await waitForVisibleSelector(page, input.selector, deadline);
    if (!element)
      throw new BrowserJobFailure(
        "selector_not_found",
        "Screenshot selector did not match an element.",
      );
    const bounds = await element.boundingBox();
    if (!bounds) {
      throw new BrowserJobFailure(
        "selector_not_found",
        "Screenshot selector did not have renderable bounds.",
      );
    }
    assertRenderBounds(bounds);
    return await withDeadline(() => element.screenshot(screenshotOptions), deadline);
  }
  const bounds: unknown = input.fullPage
    ? await page.evaluate(FULL_PAGE_BOUNDS_EXPRESSION)
    : input.viewportSize;
  assertRenderBounds(bounds);
  return await withDeadline(
    () => page.screenshot({ ...screenshotOptions, fullPage: input.fullPage }),
    deadline,
  );
}

/** Capture job: writes `screenshot.<format>` and `result.json`. */
export async function runCaptureJob(context: BrowserJobContext, input: CaptureInput) {
  if (!isAllowedNavigation(input.url, context.targets)) {
    throw new BrowserJobFailure("origin_not_allowed", "Screenshot target origin is not allowed.");
  }
  const captured = await withGuardedPage(context, input, async (guarded) => {
    const { deadline } = guarded;
    await guarded.goto(input.url);
    await guarded.page
      .waitForNetworkIdle({ idleTime: 500, timeout: Math.min(remainingTimeout(deadline), 10_000) })
      .catch(() => undefined);
    remainingTimeout(deadline);
    if (input.waitForSelector)
      await waitForVisibleSelector(guarded.page, input.waitForSelector, deadline);
    const bytes = await captureBytes(guarded, input, deadline);
    await guarded.assertNoPopup();
    return { bytes, finalUrl: guarded.page.url() };
  });
  assertImageSize(captured.bytes.byteLength);
  await writeFile(join(context.jobDirectory, `screenshot.${input.format}`), captured.bytes);
  await writeFile(
    join(context.jobDirectory, "result.json"),
    JSON.stringify({
      byteSize: captured.bytes.byteLength,
      capturedAt: new Date().toISOString(),
      contentType: `image/${input.format}`,
      finalUrl: captured.finalUrl,
      sha256: createHash("sha256").update(captured.bytes).digest("hex"),
    }),
  );
}

async function executeSessionAction(guarded: GuardedPage, action: SessionAction, deadline: number) {
  const { page } = guarded;
  remainingTimeout(deadline);
  switch (action.type) {
    case "navigate":
      await guarded.goto(action.url);
      break;
    case "click":
      await waitForVisibleSelector(page, action.selector, deadline);
      await page.click(action.selector);
      break;
    case "type":
      await waitForVisibleSelector(page, action.selector, deadline);
      if (action.clear) {
        await page.click(action.selector, { count: 3 });
        await page.keyboard.press("Backspace");
      } else {
        await page.focus(action.selector);
      }
      if (action.text) await page.keyboard.type(action.text);
      break;
    case "select":
      await waitForVisibleSelector(page, action.selector, deadline);
      await page.select(action.selector, ...action.values);
      break;
    case "press":
      if (action.selector) {
        await waitForVisibleSelector(page, action.selector, deadline);
        await page.focus(action.selector);
      }
      await page.keyboard.press(action.key);
      break;
    case "wait":
      if (action.selector) await waitForVisibleSelector(page, action.selector, deadline);
      if (action.milliseconds) {
        const milliseconds = action.milliseconds;
        await withDeadline(() => sleep(milliseconds), deadline);
      }
      break;
    case "scroll":
      await page.mouse.wheel({ deltaX: action.x ?? 0, deltaY: action.y ?? 0 });
      break;
  }
  await settleAfterBrowserAction(page, deadline);
  guarded.assertAllowedOrigin();
}

/** Session job: writes viewport `screenshot.png`, `dom.html`, and `result.json`. */
export async function runSessionJob(context: BrowserJobContext, input: SessionInput) {
  if (!isAllowedNavigation(input.url, context.targets)) {
    throw new BrowserJobFailure(
      "origin_not_allowed",
      "Browser session target origin is not allowed.",
    );
  }
  assertRenderBounds(input.viewportSize);
  const evidence = await withGuardedPage(context, input, async (guarded) => {
    const { deadline, page } = guarded;
    await guarded.goto(input.url);
    await settleAfterBrowserAction(page, deadline);
    await guarded.assertNoPopup();
    const actions: { index: number; type: SessionAction["type"]; url: string }[] = [];
    for (const [index, action] of input.actions.entries()) {
      await executeSessionAction(guarded, action, deadline);
      await guarded.assertNoPopup();
      actions.push({ index, type: action.type, url: page.url() });
    }
    const dom = truncateUtf8(await page.content(), MAX_SESSION_DOM_BYTES);
    const screenshot = await withDeadline(
      () => page.screenshot({ encoding: "binary", fullPage: false, type: "png" }),
      deadline,
    );
    assertImageSize(screenshot.byteLength);
    await guarded.assertNoPopup();
    return {
      actions,
      dom,
      finalUrl: page.url(),
      screenshot,
      title: truncateUtf8(await page.title(), MAX_SESSION_TITLE_BYTES).text,
    };
  });
  await writeFile(join(context.jobDirectory, "screenshot.png"), evidence.screenshot);
  await writeFile(join(context.jobDirectory, "dom.html"), evidence.dom.text, "utf8");
  await writeFile(
    join(context.jobDirectory, "result.json"),
    JSON.stringify({
      actions: evidence.actions,
      capturedAt: new Date().toISOString(),
      domTruncated: evidence.dom.truncated,
      finalUrl: evidence.finalUrl,
      title: evidence.title,
    }),
  );
}

const WARM_UP_PAGE_TIMEOUT_MS = 30_000;
const WARM_UP_HTML = [
  '<p style="font-family: sans-serif">Deployments.ai</p>',
  '<p style="font-family: serif">漢字 かな 한글</p>',
  '<p style="font-family: monospace">0123456789</p>',
  "<p>😀</p>",
].join("");

/**
 * Launches Chromium and renders Latin, CJK, and emoji text once, writing nothing. The image's
 * `/validate` hook runs it so Lambda prefetches what a first browser job reads (control_server.py).
 */
export async function runWarmUp() {
  const guarded = await openGuardedPage({
    registerEmergencyCleanup: () => undefined,
    targets: { allowedOrigins: new Set(), anyPublicOrigin: false },
    timeoutMs: WARM_UP_PAGE_TIMEOUT_MS,
    viewportSize: { height: 900, width: 1280 },
  });
  try {
    await guarded.page.setContent(WARM_UP_HTML);
    await withDeadline(() => guarded.page.screenshot({ type: "png" }), guarded.deadline);
  } finally {
    await guarded.close();
  }
}
