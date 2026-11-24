import { runInNewContext } from "node:vm";
import type { RestApiResponse } from "./http-responses.ts";
import type { RestApiEvent } from "./http.ts";

type Listener = () => unknown;

const SELECTOR = /^([a-z]+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[(\w+)=([\w-]+)\])?$/u;

export class FakeElement {
  readonly descendants: FakeElement[] = [];
  disabled = false;
  hidden: boolean;
  href: string;
  readonly #listeners = new Map<string, Listener[]>();
  textContent = "";
  value = "";
  readonly #classes = new Set<string>();
  readonly classList = {
    contains: (name: string) => this.#classes.has(name),
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.#classes.has(name);
      if (on) this.#classes.add(name);
      else this.#classes.delete(name);
      return on;
    },
  };

  constructor(
    readonly tagName: string,
    readonly attributes: Readonly<Record<string, string>>,
  ) {
    this.hidden = "hidden" in attributes;
    this.href = attributes.href ?? "";
  }

  get id() {
    return this.attributes.id ?? "";
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string) {
    (this.attributes as Record<string, string>)[name] = value;
  }

  removeAttribute(name: string) {
    delete (this.attributes as Record<string, string>)[name];
  }

  addEventListener(type: string, listener: Listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  async dispatch(type: string) {
    await Promise.all((this.#listeners.get(type) ?? []).map((listener) => listener()));
  }

  focus() {}

  matches(selector: string) {
    const match = SELECTOR.exec(selector);
    if (!match) throw new Error(`The fake browser cannot match ${selector}.`);
    const [, tag, id, className, attribute, value] = match;
    return (
      (tag === undefined || tag === this.tagName) &&
      (id === undefined || id === this.id) &&
      (className === undefined || (this.attributes.class ?? "").split(" ").includes(className)) &&
      (attribute === undefined || this.attributes[attribute] === value)
    );
  }

  querySelector(selector: string) {
    return this.descendants.find((element) => element.matches(selector)) ?? null;
  }

  querySelectorAll(selector: string) {
    return this.descendants.filter((element) => element.matches(selector));
  }
}

function parsePage(html: string) {
  const document = Object.assign(new FakeElement("#document", {}), { cookie: "" });
  const open: FakeElement[] = [document];
  let script = "";
  new HTMLRewriter()
    .on("*", {
      element(tag) {
        const element = new FakeElement(tag.tagName, Object.fromEntries(tag.attributes));
        for (const ancestor of open) ancestor.descendants.push(element);
        if (!tag.canHaveContent) return;
        open.push(element);
        tag.onEndTag(() => {
          open.pop();
        });
      },
    })
    .onDocument({
      text(chunk) {
        const element = open.at(-1)!;
        if (element.tagName === "script") script += chunk.text;
        else element.textContent += chunk.text;
      },
    })
    .transform(html);
  return { document, script };
}

function cookieHeader(jar: ReadonlyMap<string, string>, extra: string | undefined) {
  return [...[...jar].map(([name, value]) => `${name}=${value}`), ...(extra ? [extra] : [])].join(
    "; ",
  );
}

export function fakeBrowser(
  handle: (event: RestApiEvent) => Promise<RestApiResponse>,
  origin: string,
) {
  const cookies = new Map<string, string>();
  const requests: string[] = [];
  const inFlight = new Set<Promise<unknown>>();

  async function request(event: RestApiEvent) {
    const response = await handle({
      ...event,
      headers: { ...event.headers, cookie: cookieHeader(cookies, event.headers?.cookie) },
    });
    const setCookies = [
      ...(response.multiValueHeaders?.["Set-Cookie"] ?? []),
      ...(response.headers["Set-Cookie"] ? [response.headers["Set-Cookie"]] : []),
    ];
    for (const header of setCookies) {
      const [, name = "", value = ""] = /^([^=]+)=([^;]*)/u.exec(header) ?? [];
      if (/Max-Age=0(?:;|$)/u.test(header)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  }

  async function settle() {
    do {
      await Promise.all(inFlight);
      await Bun.sleep(0);
    } while (inFlight.size > 0);
  }

  async function open(href: string) {
    const url = new URL(href, origin);
    const page = await request({
      httpMethod: "GET",
      path: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
    });
    const { document, script } = parsePage(page.body);
    const location = {
      assign: (next: string) => {
        location.href = next;
      },
      hash: url.hash,
      href: url.href,
      pathname: url.pathname,
    };
    const fetch = (path: string, init: { body: string; headers: Record<string, string> }) => {
      requests.push(`POST ${path}`);
      const response = request({
        body: init.body,
        headers: { ...init.headers, origin },
        httpMethod: "POST",
        path,
      }).then((result) => ({
        json: async () => JSON.parse(result.body) as unknown,
        ok: result.statusCode < 400,
        status: result.statusCode,
      }));
      inFlight.add(response);
      void response.finally(() => inFlight.delete(response));
      return response;
    };
    const history = {
      replaceState: (_state: unknown, _title: string, next: string) => {
        const replaced = new URL(next, url);
        location.hash = replaced.hash;
        location.pathname = replaced.pathname;
      },
    };
    Object.defineProperty(document, "cookie", { get: () => cookieHeader(cookies, undefined) });
    runInNewContext(script, {
      URL,
      addEventListener: () => undefined,
      document,
      fetch,
      history,
      location,
    });
    await settle();
    const element = (selector: string) => {
      const found = document.querySelector(selector);
      if (!found) throw new Error(`The page has no ${selector}.`);
      return found;
    };
    return {
      async click(selector: string) {
        await element(selector).dispatch("click");
        await settle();
      },
      element,
      location,
    };
  }

  return { cookies, open, request, requests };
}
