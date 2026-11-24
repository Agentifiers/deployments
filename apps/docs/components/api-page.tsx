"use client";
import { createCodeUsageGeneratorRegistry } from "fumadocs-openapi/requests/generators";
import { curl } from "fumadocs-openapi/requests/generators/curl";
import { createOpenAPIPage } from "fumadocs-openapi/ui";

const codeUsages = createCodeUsageGeneratorRegistry();
codeUsages.add("curl", curl);

export const OpenAPIPage = createOpenAPIPage({ codeUsages, playground: { enabled: false } });
