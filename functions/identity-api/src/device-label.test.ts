import { expect, test } from "bun:test";
import { deviceLabel } from "./device-label.ts";

test("names the browser and system from real user agents, not the engines they imitate", () => {
  const agents = {
    androidChrome:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    chromeOs:
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    curl: "curl/8.7.1",
    edgeWindows:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    iphoneChrome:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
    iphoneSafari:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    macChrome:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    macSafari:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    operaMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  };

  expect(
    Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, deviceLabel(agent)])),
  ).toEqual({
    androidChrome: "Chrome on Android",
    chromeOs: "Chrome on ChromeOS",
    curl: undefined,
    edgeWindows: "Edge on Windows",
    firefoxLinux: "Firefox on Linux",
    iphoneChrome: "Chrome on iOS",
    iphoneSafari: "Safari on iOS",
    macChrome: "Chrome on macOS",
    macSafari: "Safari on macOS",
    operaMac: "Opera on macOS",
  });
  expect(deviceLabel(undefined)).toBeUndefined();
});
