import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chromium from "@sparticuz/chromium-min";
import puppeteer, {
  type Browser,
  type CDPSession,
  type HTTPRequest,
  type Page,
} from "puppeteer-core";
import {
  EGRESS_REFUSED_HEADER,
  startBrowserEgressProxy,
  type BrowserEgressProxy,
} from "./egress-proxy.ts";
import {
  BROWSER_LAUNCH_TIMEOUT_MS,
  BrowserJobFailure,
  isAllowedNavigation,
  navigationFailure,
  sandboxControlPort,
  selectorFailure,
  targetsSandboxControlServer,
  type NavigationTargets,
  type ViewportSize,
} from "./job-rules.ts";

/** Pre-extracted at image build time from the pinned @sparticuz/chromium pack (see Dockerfile). */
export const CHROMIUM_EXECUTABLE_PATH = "/opt/agent-sandbox/chromium/chromium";

export function remainingTimeout(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BrowserJobFailure("timeout", "Browser job timed out.");
  return remaining;
}

export async function withDeadline<T>(operation: () => Promise<T>, deadline: number) {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timeout = setTimeout(
    () => reject(new BrowserJobFailure("timeout", "Browser job timed out.")),
    remainingTimeout(deadline),
  );
  try {
    return await Promise.race([operation(), expired]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForVisibleSelector(page: Page, selector: string, deadline: number) {
  try {
    return await page.waitForSelector(selector, {
      timeout: remainingTimeout(deadline),
      visible: true,
    });
  } catch (error) {
    throw selectorFailure(error, selector);
  }
}

export async function settleAfterBrowserAction(page: Page, deadline: number) {
  await page
    .waitForNetworkIdle({ idleTime: 250, timeout: Math.min(1_500, remainingTimeout(deadline)) })
    .catch(() => undefined);
}

export interface PopupGuard {
  /** Waits for pending target handling; throws `popup_not_allowed` once any popup was attempted. */
  readonly assertNoPopup: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export async function installBrowserPopupGuard(browser: Browser, page: Page): Promise<PopupGuard> {
  const session = await browser.target().createCDPSession();
  // CdpTarget keeps the CDP target id on `_targetId`; the public Target API does not expose it.
  const primaryTargetId: unknown = Reflect.get(page.target(), "_targetId");
  if (typeof primaryTargetId !== "string" || !primaryTargetId) {
    await session.detach().catch(() => undefined);
    throw new Error("Chromium did not expose the primary page target id.");
  }
  const pending = new Set<Promise<void>>();
  const configuredSessions = new Set<string>();
  let popupAttempted = false;
  let protocolFailure: unknown;
  type AttachedHandler = (event: {
    readonly sessionId: string;
    readonly targetInfo: { readonly targetId: string; readonly type: string };
  }) => void;
  const track = (operation: Promise<unknown>) => {
    const tracked = operation
      .then(() => undefined)
      .catch((cause: unknown) => {
        protocolFailure = cause;
      })
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  // Chrome attaches page targets through tab targets and rejects a filter that allows both.
  const autoAttach = {
    autoAttach: true,
    filter: [
      { exclude: true, type: "browser" as const },
      { exclude: true, type: "tab" as const },
      {},
    ],
    flatten: true,
    waitForDebuggerOnStart: true,
  };
  const handlers = new Map<CDPSession, AttachedHandler>();
  const attached: AttachedHandler = (event) => {
    const child = session.connection()?.session(event.sessionId) ?? null;
    if (!child) {
      protocolFailure = new Error("Chromium did not expose an auto-attached target session.");
      return;
    }
    if (event.targetInfo.type === "page" && event.targetInfo.targetId !== primaryTargetId) {
      popupAttempted = true;
      track(
        session
          .send("Target.closeTarget", { targetId: event.targetInfo.targetId })
          .then((result) => {
            if (!result.success) throw new Error("Chromium refused to close a popup target.");
          }),
      );
      return;
    }
    if (configuredSessions.has(child.id())) return;
    configuredSessions.add(child.id());
    handlers.set(child, attached);
    child.on("Target.attachedToTarget", attached);
    track(
      child
        .send("Target.setAutoAttach", autoAttach)
        .then(() => child.send("Runtime.runIfWaitingForDebugger")),
    );
  };
  handlers.set(session, attached);
  configuredSessions.add(session.id());
  session.on("Target.attachedToTarget", attached);
  await session.send("Target.setAutoAttach", autoAttach);
  while (pending.size > 0) await Promise.all(pending);
  if (protocolFailure !== undefined) {
    await session.detach().catch(() => undefined);
    throw new Error("Browser popup guard failed to initialize.", { cause: protocolFailure });
  }
  return {
    assertNoPopup: async () => {
      while (pending.size > 0) await Promise.all(pending);
      if (protocolFailure !== undefined) {
        throw new Error("Browser popup guard failed.", { cause: protocolFailure });
      }
      if (popupAttempted) {
        throw new BrowserJobFailure(
          "popup_not_allowed",
          "Browser popup navigation is not allowed.",
        );
      }
    },
    dispose: async () => {
      for (const [attachedSession, handler] of handlers)
        attachedSession.off("Target.attachedToTarget", handler);
      await session
        .send("Target.setAutoAttach", {
          autoAttach: false,
          flatten: true,
          waitForDebuggerOnStart: false,
        })
        .catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}

export interface GuardedPage {
  readonly assertAllowedOrigin: () => void;
  readonly assertNoPopup: () => Promise<void>;
  /** Closes the browser and deletes the temporary profile. */
  readonly close: () => Promise<void>;
  readonly goto: (url: string) => Promise<void>;
  /** Epoch-ms deadline for page work: browser ready + spec `timeoutMs`. */
  readonly deadline: number;
  readonly page: Page;
}

/**
 * Launches a fresh headless Chromium with a throwaway profile, keeps one page at the requested
 * viewport, blocks popups, aborts main-frame navigations the targets do not allow, and aborts every
 * request (any frame or resource type) aimed at the sandbox control server. In any-public mode,
 * Chromium sends every request, loopback included, through the guest egress proxy, which connects
 * only to public addresses and to the exact allowed origins.
 * Launch is bounded by `BROWSER_LAUNCH_TIMEOUT_MS` whatever the spec `timeoutMs`; that page budget
 * starts once the browser is up (the worker's deadline reserves slack for allocation and launch).
 * `registerEmergencyCleanup` receives a synchronous kill-and-delete used when the job process is
 * terminated before `close` can run.
 */
export async function openGuardedPage(options: {
  readonly registerEmergencyCleanup: (cleanup: () => void) => void;
  readonly targets: NavigationTargets;
  readonly timeoutMs: number;
  readonly viewportSize: ViewportSize;
}): Promise<GuardedPage> {
  const { targets } = options;
  const controlPort = sandboxControlPort(process.env);
  const userDataDir = await mkdtemp(join(tmpdir(), "deployments-ai-browser-profile-"));
  let browser: Browser | undefined;
  let popupGuard: PopupGuard | undefined;
  let proxy: BrowserEgressProxy | undefined;
  options.registerEmergencyCleanup(() => {
    browser?.process()?.kill("SIGKILL");
    rmSync(userDataDir, { force: true, recursive: true });
  });
  const close = async () => {
    await popupGuard?.dispose();
    await browser?.close().catch(() => browser?.process()?.kill("SIGKILL"));
    await proxy?.close();
    await rm(userDataDir, { force: true, recursive: true });
  };
  try {
    if (targets.anyPublicOrigin) {
      proxy = await startBrowserEgressProxy({ exactOrigins: targets.allowedOrigins });
    }
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        // `<-loopback>` removes Chromium's implicit loopback bypass, so loopback goes through it too.
        ...(proxy ? [`--proxy-server=${proxy.url}`, "--proxy-bypass-list=<-loopback>"] : []),
      ],
      defaultViewport: null,
      executablePath: CHROMIUM_EXECUTABLE_PATH,
      handleSIGHUP: false,
      handleSIGINT: false,
      handleSIGTERM: false,
      headless: "shell",
      pipe: true,
      protocolTimeout: Math.max(BROWSER_LAUNCH_TIMEOUT_MS, options.timeoutMs),
      timeout: BROWSER_LAUNCH_TIMEOUT_MS,
      userDataDir,
    });
    const deadline = Date.now() + options.timeoutMs;
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await Promise.all(
      pages.filter((candidate) => candidate !== page).map((extra) => extra.close()),
    );
    await page.setViewport(options.viewportSize);
    popupGuard = await installBrowserPopupGuard(browser, page);
    // `refused` tracks the latest main-frame response: the proxy's refusal renders as an empty page
    // that Chromium treats as loaded, so it must fail the navigation like a blocked request does.
    const navigation = { blocked: false, refused: false };
    page.on("response", (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigation.refused = response.headers()[EGRESS_REFUSED_HEADER] === "1";
      }
    });
    const allowed = (url: string) => !navigation.refused && isAllowedNavigation(url, targets);
    await page.setRequestInterception(true);
    page.on("request", (request: HTTPRequest) => {
      const url = request.url();
      const isMainFrameNavigation =
        request.isNavigationRequest() && request.frame() === page.mainFrame();
      const permitted =
        !targetsSandboxControlServer(url, controlPort, targets.allowedOrigins) &&
        (!isMainFrameNavigation || isAllowedNavigation(url, targets));
      if (!permitted && isMainFrameNavigation) navigation.blocked = true;
      void (permitted ? request.continue() : request.abort("blockedbyclient"));
    });
    page.setDefaultTimeout(remainingTimeout(deadline));
    page.setDefaultNavigationTimeout(remainingTimeout(deadline));
    const guard = popupGuard;
    return {
      assertNoPopup: () => guard.assertNoPopup(),
      close,
      deadline,
      /** Navigates the main frame; blocked off-origin hops fail as `origin_not_allowed`. */
      goto: async (url: string) => {
        if (!isAllowedNavigation(url, targets)) {
          throw new BrowserJobFailure(
            "origin_not_allowed",
            "Browser navigation target origin is not allowed.",
          );
        }
        navigation.blocked = false;
        navigation.refused = false;
        try {
          await page.goto(url, {
            timeout: remainingTimeout(deadline),
            waitUntil: "domcontentloaded",
          });
        } catch (error) {
          throw navigationFailure(error, navigation.blocked);
        }
        if (!allowed(page.url())) {
          throw new BrowserJobFailure(
            "origin_not_allowed",
            "Browser redirect target origin is not allowed.",
          );
        }
      },
      /** Post-action rule: the main page must still be on an allowed origin. */
      assertAllowedOrigin: () => {
        if (!allowed(page.url())) {
          throw new BrowserJobFailure(
            "origin_not_allowed",
            "Browser session navigation reached an origin that is not allowed.",
          );
        }
      },
      page,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
