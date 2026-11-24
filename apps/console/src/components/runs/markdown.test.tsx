import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  test("renders a list with bold text and an external link", () => {
    const out = html("Here:\n\n* **First** item\n* See [the docs](https://example.com/docs)");
    expect(out).toContain("<ul");
    expect(out).toContain("<li><span><strong");
    expect(out).toContain(">First</strong> item</span></li>");
    expect(out).toContain(
      '<a class="font-medium text-foreground underline underline-offset-4 hover:text-foreground/70" href="https://example.com/docs" rel="noreferrer" target="_blank">the docs</a>',
    );
    expect(out).not.toContain("**");
    expect(out).not.toContain("* ");
  });

  test("escapes raw HTML instead of rendering it", () => {
    const out = html('Hi <img src=x onerror="alert(1)"> there\n\n<script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });

  test("keeps a link with an unsafe protocol as plain text", () => {
    const out = html("[click](javascript:alert(1)) and ![pic](data:image/png;base64,AA==)");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("click and pic");
  });

  test("renders fenced code verbatim", () => {
    expect(html("```\nif (a < b) {}\n```")).toContain("<code>if (a &lt; b) {}</code>");
  });
});
