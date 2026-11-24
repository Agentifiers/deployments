import type { AppAudience, AppResponse, AppServing } from "@deployments-ai/api-contract";
import { liveReleaseId } from "./app-state.ts";

export interface PublicationChoice {
  readonly description: string;
  readonly label: string;
}

export const APP_AUDIENCES = ["members", "public"] as const satisfies readonly AppAudience[];

export const APP_SERVINGS = ["single-page", "static-site"] as const satisfies readonly AppServing[];

export const AUDIENCE_CHOICES: Readonly<Record<AppAudience, PublicationChoice>> = {
  members: {
    description:
      "Only signed-in members of the organization open the app, with the member access and grants of this page.",
    label: "Members",
  },
  public: {
    description:
      "Anyone on the internet can load the app's pages and call its visitor functions without signing in. The app's other functions still need a signed-in member.",
    label: "Public",
  },
};

export const SERVING_CHOICES: Readonly<Record<AppServing, PublicationChoice>> = {
  "single-page": {
    description:
      "Every page path returns the release's index.html, and the app draws each page in the browser.",
    label: "Single-page app",
  },
  "static-site": {
    description:
      "Each page path returns its own HTML file from the release, so /about returns about.html. Pages load without JavaScript and link to each other as plain pages.",
    label: "Static site",
  },
};

/** Why a public app does not reach visitors yet, or `undefined` when its audience is what it serves. */
export function publicationNotice(
  app: Pick<AppResponse, "lifecycle" | "publication">,
): string | undefined {
  if (app.publication.audience !== "public") return undefined;
  if (app.lifecycle.state !== "active") {
    return `Visitors cannot open the app while it is ${app.lifecycle.state}. Only an active app with a live release is public.`;
  }
  return liveReleaseId(app.lifecycle) === null
    ? "Visitors reach the app once it has a live release."
    : undefined;
}
