// Order matters: Edge and Opera user agents also name Chrome and Safari, and Chrome names Safari.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//u, "Edge"],
  [/\b(?:OPR|Opera)\//u, "Opera"],
  [/\bSamsungBrowser\//u, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//u, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//u, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//u, "Safari"],
];

// iOS before macOS (iPhone user agents say "like Mac OS X"), Android and ChromeOS before Linux.
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\biPad\b/u, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/u, "iOS"],
  [/\bMac OS X\b/u, "macOS"],
  [/\bAndroid\b/u, "Android"],
  [/\bCrOS\b/u, "ChromeOS"],
  [/\bWindows\b/u, "Windows"],
  [/\bLinux\b/u, "Linux"],
];

function first(table: readonly (readonly [RegExp, string])[], userAgent: string) {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1];
}

/**
 * A coarse label such as "Chrome on macOS" for the account page's session list. Sessions keep
 * only this label and a hash of the user agent, never the user agent itself.
 */
export function deviceLabel(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const browser = first(BROWSERS, userAgent);
  const system = first(SYSTEMS, userAgent);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}
