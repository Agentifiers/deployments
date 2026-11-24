import { Card, Cards } from "fumadocs-ui/components/card";
import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/layout.shared";

const SECTIONS = [
  {
    title: "Get started",
    href: "/docs/getting-started/quickstart/",
    description:
      "Install the CLI, sign in, and take an agent from manifest to a running deployment.",
  },
  {
    title: "Platform",
    href: "/docs/capabilities/agents/",
    description: "Agents, runs, tools, knowledge, messaging, evaluations, and governance.",
  },
  {
    title: "HTTP API",
    href: "/docs/api/",
    description: "Every public operation with schemas, authentication, and SDK and CLI samples.",
  },
  {
    title: "CLI",
    href: "/docs/cli/",
    description:
      "The deployments command: profiles, context, scripting, and the full command reference.",
  },
  {
    title: "TypeScript SDK",
    href: "/docs/sdk/",
    description: "The generated client: authentication, requests, errors, streaming, and webhooks.",
  },
  {
    title: "Operate",
    href: "/docs/operate/",
    description:
      "Architecture, deployment, security, and the runtime services behind the platform.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-6 py-16">
      <section className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight">{PRODUCT_NAME}</h1>
        <p className="text-fd-muted-foreground max-w-2xl text-lg">
          A multi-tenant control plane and runtime for building, versioning, deploying, and
          operating AI agents. Reach it through the management console, the <code>deployments</code>{" "}
          CLI, the TypeScript SDK, or the HTTP API.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs/getting-started/quickstart/"
            className="bg-fd-primary text-fd-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
          >
            Quickstart
          </Link>
          <Link
            href="/docs/api/"
            className="border-fd-border rounded-md border px-4 py-2 text-sm font-medium"
          >
            API reference
          </Link>
        </div>
      </section>
      <Cards>
        {SECTIONS.map((section) => (
          <Card key={section.href} title={section.title} href={section.href}>
            {section.description}
          </Card>
        ))}
      </Cards>
    </main>
  );
}
