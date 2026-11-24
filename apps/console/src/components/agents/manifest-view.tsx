import { useMemo } from "react";
import { canonicalManifestJson } from "../../agents/manifest-diff.ts";
import { CodeBlock, CodeBlockCopyButton } from "@/components/reui/code-block/code-block";

/**
 * A manifest as canonical, pretty-printed JSON (keys sorted the way the platform hashes them),
 * read-only, with a copy button.
 */
export function ManifestView({ label, manifest }: Readonly<{ label: string; manifest: unknown }>) {
  const json = useMemo(() => canonicalManifestJson(manifest), [manifest]);
  return (
    <CodeBlock code={json} defaultWrap label={label} language="json" maxLines={23}>
      <CodeBlockCopyButton alwaysVisible labels={{ copy: `Copy ${label}` }} />
    </CodeBlock>
  );
}
