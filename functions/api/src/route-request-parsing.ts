export function routePattern(path: string) {
  const names: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      names.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { names, pattern: new RegExp(`^${source}$`, "u") };
}

export async function requestBody(request: Request) {
  if (request.method === "GET") return undefined;
  const text = await request.text();
  return text ? JSON.parse(text) : undefined;
}
