import type { GeneratedPageProps } from "fumadocs-openapi";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { OpenAPIPage } from "@/components/api-page";
import { operationDocument } from "@/lib/openapi";

function ReferencePage({ operations = [], showDescription }: GeneratedPageProps) {
  return (
    <OpenAPIPage
      payload={{ bundled: operationDocument(operations) }}
      operations={operations}
      {...(showDescription === undefined ? {} : { showDescription })}
    />
  );
}

export const docsComponents = {
  ...defaultMdxComponents,
  Accordion,
  Accordions,
  File,
  Files,
  Folder,
  OpenAPIPage: ReferencePage,
  Step,
  Steps,
  Tab,
  Tabs,
  TypeTable,
} satisfies MDXComponents;

export function getMDXComponents(overrides?: MDXComponents): MDXComponents {
  return { ...docsComponents, ...overrides };
}
