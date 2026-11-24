export interface PresignedUrl {
  readonly expiresAt: string;
  readonly url: string;
}

export interface FreshTab {
  opener: unknown;
  readonly location: { href: string };
  close(): void;
}

export interface FreshLinkBrowser {
  readonly download: (url: string) => void;
  readonly openTab: () => FreshTab | null;
}

/** `view` shows the link in a new tab; `download` saves an attachment without leaving the page. */
export type FreshLinkDisposition = "download" | "view";

export type FreshLinkOutcome =
  | { readonly kind: "blocked" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly error: Error }
  | { readonly kind: "opened" };

interface FreshLinkTarget {
  abandon(): void;
  go(url: string): void;
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * One link at a time: a click while a mint is pending opens nothing. A view tab must open before
 * the first await so popup blockers see it as part of the click.
 */
export function freshLinkOpener(browser: FreshLinkBrowser, setPending: (pending: boolean) => void) {
  let pending = false;

  function target(disposition: FreshLinkDisposition): FreshLinkTarget | null {
    if (disposition === "download") return { abandon: () => {}, go: browser.download };
    const tab = browser.openTab();
    if (!tab) return null;
    tab.opener = null;
    return {
      abandon: () => tab.close(),
      go: (url) => {
        tab.location.href = url;
      },
    };
  }

  return async (
    disposition: FreshLinkDisposition,
    mint: () => Promise<PresignedUrl>,
  ): Promise<FreshLinkOutcome> => {
    if (pending) return { kind: "busy" };
    const link = target(disposition);
    if (!link) return { kind: "blocked" };
    pending = true;
    setPending(true);
    try {
      const { url } = await mint();
      if (!isHttps(url)) throw new Error("The platform returned a link that is not https.");
      link.go(url);
      return { kind: "opened" };
    } catch (error) {
      link.abandon();
      return { error: error instanceof Error ? error : new Error(String(error)), kind: "failed" };
    } finally {
      pending = false;
      setPending(false);
    }
  };
}
