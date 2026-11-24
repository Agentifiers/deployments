import { liveReleaseIdOf, type AppRecord, type ReleaseDocumentPath } from "@deployments-ai/db";
import type { ServedRole } from "./admission.ts";
import type { GatewayLookups } from "./lookups.ts";
import { resolvePage } from "./page-resolution.ts";
import type { RenderedPages } from "./rendered-pages.ts";
import { htmlResponse, platformPage, redirect, type Handled } from "./responses.ts";

export interface PageContext {
  readonly lookups: Pick<GatewayLookups, "releaseDocuments">;
  readonly pages: RenderedPages;
}

export interface PageRequest {
  readonly pathname: string;
  readonly search: string;
}

function pageNotFound(message: string) {
  return platformPage({ message, status: 404, title: "Page not found" });
}

/** `documentRefusal` runs only for requests answered with a page, not for redirects. */
export async function livePage(
  context: PageContext,
  app: AppRecord,
  role: ServedRole,
  request: PageRequest,
  documentRefusal: () => Handled | undefined = () => undefined,
): Promise<Handled> {
  const releaseId = liveReleaseIdOf(app.data.lifecycle);
  if (releaseId === null) {
    return {
      reason: "not-published",
      response: platformPage({
        message: `${app.data.name} has not been published yet.`,
        status: 200,
        title: app.data.name,
      }),
      role,
    };
  }
  const { serving } = app.data.publication;
  const render = (document: ReleaseDocumentPath) =>
    context.pages({ appId: app.data.id, document, releaseId, serving });
  const resolution = resolvePage({
    documents:
      serving === "static-site" ? await context.lookups.releaseDocuments({ app, releaseId }) : null,
    pathname: request.pathname,
    serving,
  });
  if (resolution.kind !== "asset" && resolution.kind !== "canonical") {
    const refused = documentRefusal();
    if (refused !== undefined) return refused;
  }
  switch (resolution.kind) {
    case "document": {
      const html = await render(resolution.document);
      return {
        response:
          html === undefined
            ? pageNotFound(`This release has no ${resolution.document}.`)
            : htmlResponse(200, html),
        role,
      };
    }
    case "canonical":
      return { response: redirect(308, `${resolution.location}${request.search}`), role };
    case "asset":
      return {
        response: redirect(307, `/_r/${releaseId}/${resolution.path}${request.search}`),
        role,
      };
    case "not-found": {
      const html = resolution.document === null ? undefined : await render(resolution.document);
      return {
        reason: "page-not-found",
        response:
          html === undefined ? pageNotFound("This page does not exist.") : htmlResponse(404, html),
        role,
      };
    }
    case "unknown-documents":
      return {
        reason: "page-not-found",
        response: pageNotFound(
          "The live release predates static-site serving, so only its home page is served. Release and promote the app again to serve every page.",
        ),
        role,
      };
  }
}
