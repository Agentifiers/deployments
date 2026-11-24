import { Parser } from "htmlparser2";
import type { DecodedText, Extractor } from "./extractor.ts";
import { untilTextBudget } from "./text-sink.ts";
import { UnusableFile } from "./unusable.ts";

const HIDDEN: Readonly<Record<string, true>> = {
  noscript: true,
  script: true,
  style: true,
  svg: true,
  template: true,
};
const BLOCKS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "address",
    "article",
    "aside",
    "blockquote",
    "br",
    "caption",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "title",
    "tr",
    "ul",
  ].map((name) => [name, true] as const),
);
const HEADING = /^h([1-6])$/u;
const MARKER_ONLY = /^(?:#{1,6}|-|\|)$/u;

export const extractHtml: Extractor<DecodedText> = async ({ text }, context) => {
  let line = "";
  let hiddenDepth = 0;
  let preDepth = 0;
  let written = false;
  const flush = () => {
    const trimmed = line.trim();
    line = "";
    if (trimmed === "" || MARKER_ONLY.test(trimmed)) return;
    written = true;
    context.sink.write(`${trimmed}\n`);
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (HIDDEN[name] === true) hiddenDepth += 1;
        if (hiddenDepth > 0) return;
        if (name === "pre") preDepth += 1;
        if (BLOCKS[name] === true) flush();
        const heading = HEADING.exec(name);
        if (heading) line = `${"#".repeat(Number(heading[1]))} `;
        if (name === "li") line = "- ";
        if ((name === "td" || name === "th") && line.trim() !== "") line += " | ";
      },
      ontext(value) {
        if (hiddenDepth > 0) return;
        if (preDepth === 0) {
          line += value.replaceAll(/\s+/gu, " ");
          return;
        }
        const [first = "", ...rest] = value.split("\n");
        line += first;
        for (const next of rest) {
          flush();
          line = next;
        }
      },
      onclosetag(name) {
        if (HIDDEN[name] === true) {
          hiddenDepth = Math.max(0, hiddenDepth - 1);
          return;
        }
        if (hiddenDepth > 0) return;
        if (name === "pre") preDepth = Math.max(0, preDepth - 1);
        if (BLOCKS[name] === true) flush();
      },
    },
    { decodeEntities: true },
  );
  await untilTextBudget(() => {
    parser.write(text);
    parser.end();
    flush();
  });
  if (!written) throw new UnusableFile("no_text", "the page has no visible text");
  return { kind: "html" };
};
