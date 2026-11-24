import { lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import { Code } from "@/components/ui/text";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** Only absolute http, https, and mailto URLs become links; anything else renders as text. */
function safeHref(href: string): string | undefined {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

function ExternalLink({ children, href }: Readonly<{ children: ReactNode; href: string }>) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/70"
      href={safe}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}

function inline(tokens: readonly Token[] | undefined): ReactNode[] {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "strong":
        return (
          <strong className="font-semibold" key={index}>
            {inline(token.tokens)}
          </strong>
        );
      case "em":
        return <em key={index}>{inline(token.tokens)}</em>;
      case "del":
        return <del key={index}>{inline(token.tokens)}</del>;
      case "codespan":
        return <Code key={index}>{token.text}</Code>;
      case "br":
        return <br key={index} />;
      case "link":
        return (
          <ExternalLink href={token.href} key={index}>
            {inline(token.tokens)}
          </ExternalLink>
        );
      // Images would load third-party URLs inside the console, so they show as links.
      case "image":
        return (
          <ExternalLink href={token.href} key={index}>
            {token.text || token.href}
          </ExternalLink>
        );
      case "text":
        return "tokens" in token && token.tokens ? inline(token.tokens) : token.text;
      // Raw HTML stays literal text; React escapes it.
      default:
        return "text" in token ? token.raw : null;
    }
  });
}

function List({ token }: Readonly<{ token: Tokens.List }>) {
  const items = token.items.map((item, index) => (
    <li key={index}>
      {item.task ? (
        <input checked={item.checked ?? false} className="mr-1.5" disabled type="checkbox" />
      ) : null}
      {blocks(item.tokens, !item.loose)}
    </li>
  ));
  return token.ordered ? (
    <ol className="list-decimal space-y-1 pl-6" start={token.start === "" ? 1 : token.start}>
      {items}
    </ol>
  ) : (
    <ul className="list-disc space-y-1 pl-6">{items}</ul>
  );
}

/** `tight` list items hold bare text tokens rather than paragraphs. */
function blocks(tokens: readonly Token[], tight = false): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "space":
        return null;
      case "paragraph":
        return <p key={index}>{inline(token.tokens)}</p>;
      case "text":
        return tight ? (
          <span key={index}>{inline(token.tokens ?? [token])}</span>
        ) : (
          <p key={index}>{inline(token.tokens ?? [token])}</p>
        );
      case "heading":
        return (
          <p className="font-semibold text-foreground" key={index}>
            {inline(token.tokens)}
          </p>
        );
      case "list":
        return <List key={index} token={token as Tokens.List} />;
      case "code":
        return (
          <pre
            className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-[0.8125rem]"
            key={index}
          >
            <code>{token.text}</code>
          </pre>
        );
      case "blockquote":
        return (
          <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" key={index}>
            {blocks(token.tokens ?? [])}
          </blockquote>
        );
      case "hr":
        return <hr className="border-border" key={index} />;
      case "table": {
        const table = token as Tokens.Table;
        return (
          <div className="overflow-x-auto" key={index}>
            <table className="text-left">
              <thead>
                <tr>
                  {table.header.map((cell, column) => (
                    <th className="border-b border-border px-2 py-1 font-semibold" key={column}>
                      {inline(cell.tokens)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, column) => (
                      <td className="border-b border-border px-2 py-1" key={column}>
                        {inline(cell.tokens)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      // Raw HTML blocks stay literal text; React escapes it.
      default:
        return (
          <p className="whitespace-pre-wrap" key={index}>
            {token.raw.trimEnd()}
          </p>
        );
    }
  });
}

/**
 * Agent replies as Markdown, built as React elements from `marked`'s tokens so no HTML string
 * reaches the DOM: raw HTML shows as text, and only http, https, and mailto links are clickable.
 */
export function Markdown({ className, text }: Readonly<{ className?: string; text: string }>) {
  return <div className={className}>{blocks(lexer(text))}</div>;
}
