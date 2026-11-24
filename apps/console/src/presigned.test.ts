import { describe, expect, test } from "bun:test";
import { freshLinkOpener, type FreshTab, type PresignedUrl } from "./presigned.ts";

const EXPIRES_AT = "2026-10-08T00:05:00.000Z";

function browser() {
  const tabs: { closed: boolean; href: string; opener: unknown }[] = [];
  const downloads: string[] = [];
  const pending: boolean[] = [];
  const open = freshLinkOpener(
    {
      download: (url) => downloads.push(url),
      openTab: (): FreshTab => {
        const tab = { closed: false, href: "about:blank", opener: {} as unknown };
        tabs.push(tab);
        return {
          close: () => {
            tab.closed = true;
          },
          location: {
            set href(url: string) {
              tab.href = url;
            },
          },
          set opener(value: unknown) {
            tab.opener = value;
          },
        };
      },
    },
    (value) => pending.push(value),
  );
  return { downloads, open, pending, tabs };
}

const minted = (url: string) => async (): Promise<PresignedUrl> => ({ expiresAt: EXPIRES_AT, url });

describe("freshLinkOpener", () => {
  test("navigates the tab it opened to an https link and severs the opener", async () => {
    const { downloads, open, pending, tabs } = browser();
    expect(await open("view", minted("https://exports.example.com/a?sig=1"))).toEqual({
      kind: "opened",
    });
    expect(tabs).toEqual([
      { closed: false, href: "https://exports.example.com/a?sig=1", opener: null },
    ]);
    expect(downloads).toEqual([]);
    expect(pending).toEqual([true, false]);
  });

  test("downloads an https link in the current page without opening a tab", async () => {
    const { downloads, open, pending, tabs } = browser();
    expect(await open("download", minted("https://exports.example.com/raw.eml?sig=1"))).toEqual({
      kind: "opened",
    });
    expect({ downloads, tabs }).toEqual({
      downloads: ["https://exports.example.com/raw.eml?sig=1"],
      tabs: [],
    });
    expect(pending).toEqual([true, false]);
  });

  test("accepts an https link in browsers without URL.parse", async () => {
    const parse = Object.getOwnPropertyDescriptor(URL, "parse");
    Reflect.deleteProperty(URL, "parse");
    try {
      const { downloads, open, tabs } = browser();
      expect(await open("view", minted("https://exports.example.com/e"))).toEqual({
        kind: "opened",
      });
      expect(await open("download", minted("https://exports.example.com/f"))).toEqual({
        kind: "opened",
      });
      expect({ downloads, hrefs: tabs.map(({ href }) => href) }).toEqual({
        downloads: ["https://exports.example.com/f"],
        hrefs: ["https://exports.example.com/e"],
      });
    } finally {
      if (parse) Object.defineProperty(URL, "parse", parse);
    }
  });

  test("refuses any link that is not https and closes the tab", async () => {
    const { downloads, open, tabs } = browser();
    const outcomes: string[] = [];
    for (const url of ["http://exports.example.com/a", "javascript:alert(1)", "/relative"]) {
      outcomes.push((await open("view", minted(url))).kind);
      outcomes.push((await open("download", minted(url))).kind);
    }
    expect(outcomes).toEqual(["failed", "failed", "failed", "failed", "failed", "failed"]);
    expect(downloads).toEqual([]);
    expect(tabs.map(({ closed, href }) => ({ closed, href }))).toEqual([
      { closed: true, href: "about:blank" },
      { closed: true, href: "about:blank" },
      { closed: true, href: "about:blank" },
    ]);
  });

  test("ignores clicks while a link is minting", async () => {
    const { downloads, open, tabs } = browser();
    let release = (_url: PresignedUrl) => {};
    let mints = 0;
    const slow = () => {
      mints += 1;
      return new Promise<PresignedUrl>((resolve) => {
        release = resolve;
      });
    };
    const first = open("view", slow);
    expect(await open("view", slow)).toEqual({ kind: "busy" });
    expect(await open("download", slow)).toEqual({ kind: "busy" });
    release({ expiresAt: EXPIRES_AT, url: "https://exports.example.com/b" });
    expect(await first).toEqual({ kind: "opened" });
    expect({ downloads: downloads.length, mints, tabs: tabs.length }).toEqual({
      downloads: 0,
      mints: 1,
      tabs: 1,
    });
    expect(await open("download", minted("https://exports.example.com/c"))).toEqual({
      kind: "opened",
    });
  });

  test("reports a blocked pop-up without minting", async () => {
    let mints = 0;
    const open = freshLinkOpener({ download: () => {}, openTab: () => null }, () => {});
    expect(
      await open("view", async () => {
        mints += 1;
        return { expiresAt: EXPIRES_AT, url: "https://exports.example.com/d" };
      }),
    ).toEqual({ kind: "blocked" });
    expect(mints).toBe(0);
  });
});
