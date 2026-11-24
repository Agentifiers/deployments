import { ResourceDescription, ResourceName } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";
import { isSlug } from "./slug.ts";

/** A tenancy resource with a settings page; each level's ID names it under its parents. */
export type TenancyRef =
  | { readonly level: "organization"; readonly organizationId: string }
  | { readonly level: "project"; readonly organizationId: string; readonly projectId: string }
  | {
      readonly level: "environment";
      readonly environmentId: string;
      readonly organizationId: string;
      readonly projectId: string;
    }
  | {
      readonly level: "workspace";
      readonly environmentId: string;
      readonly organizationId: string;
      readonly projectId: string;
      readonly workspaceId: string;
    };

export type TenancyLevel = TenancyRef["level"];
export type ArchivableLevel = Exclude<TenancyLevel, "organization">;

/** The fields every level's response shares; only a workspace has a description. */
export interface TenancyResource {
  readonly createdAt: string;
  readonly description?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "archived" | "disabled";
  readonly updatedAt: string;
  readonly version: number;
}

/** The IDs each level's server functions require, in `requireIds` form. */
export const TENANCY_REF_IDS = {
  environment: ["environmentId", "organizationId", "projectId"],
  organization: ["organizationId"],
  project: ["organizationId", "projectId"],
  workspace: ["environmentId", "organizationId", "projectId", "workspaceId"],
} as const satisfies Readonly<Record<TenancyLevel, readonly string[]>>;

export const TENANCY_LEVELS = Object.keys(TENANCY_REF_IDS) as readonly TenancyLevel[];

interface LevelCopy {
  readonly describes: boolean;
  readonly noun: string;
  /** Where the slug must be unique. */
  readonly slugUniqueIn: string;
}

export const LEVEL_COPY: Readonly<Record<TenancyLevel, LevelCopy>> = {
  environment: { describes: false, noun: "environment", slugUniqueIn: "its project" },
  organization: { describes: false, noun: "organization", slugUniqueIn: "this install" },
  project: { describes: false, noun: "project", slugUniqueIn: "this organization" },
  workspace: { describes: true, noun: "workspace", slugUniqueIn: "this environment" },
};

/** What archiving changes, from the API's archive handlers and the scope checks that read status. */
export const ARCHIVE_EFFECTS: Readonly<Record<ArchivableLevel, readonly string[]>> = {
  environment: [
    "Nothing is deleted, and deployments are not stopped. Stop them first if they should stop serving.",
    "People can no longer open the environment's agents, runs, and other runtime pages.",
    "The environment accepts no new workspaces, service accounts, or API keys, and its keys cannot be rotated.",
  ],
  project: [
    "Nothing is deleted, and its environments stay active. Archive them separately to retire them.",
    "The project accepts no new environments.",
  ],
  workspace: [
    "Nothing is deleted, and its spend stays readable for billing.",
    "New runs, budgets, and connection grants can no longer name the workspace.",
  ],
};

/** The form's values; `description` is ignored for levels without one. */
export interface GeneralDraft {
  readonly description: string;
  readonly name: string;
  readonly slug: string;
}

export type GeneralChanges = {
  readonly description?: string | null;
  readonly name?: string;
  readonly slug?: string;
};

export type GeneralCheck =
  | { readonly kind: "invalid"; readonly field: "description" | "name" | "slug" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly body: GeneralChanges };

const isResourceName = Schema.is(ResourceName);
const isDescription = Schema.is(ResourceDescription);

export function generalDraft(resource: TenancyResource): GeneralDraft {
  return { description: resource.description ?? "", name: resource.name, slug: resource.slug };
}

/** The update body for the fields the draft changed; the API refuses an empty update. */
export function checkGeneral(
  level: TenancyLevel,
  current: TenancyResource,
  draft: GeneralDraft,
): GeneralCheck {
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  const description = draft.description.trim();
  if (!isResourceName(name)) return { field: "name", kind: "invalid" };
  if (!isSlug(slug)) return { field: "slug", kind: "invalid" };
  if (!isDescription(description)) return { field: "description", kind: "invalid" };
  const describedChange =
    LEVEL_COPY[level].describes && description !== (current.description ?? "")
      ? { description: description === "" ? null : description }
      : {};
  const body: GeneralChanges = {
    ...(name === current.name ? {} : { name }),
    ...(slug === current.slug ? {} : { slug }),
    ...describedChange,
  };
  return Object.keys(body).length === 0 ? { kind: "unchanged" } : { body, kind: "changed" };
}

export function tenancyResourceKey(ref: TenancyRef) {
  return ["tenancy-resource", ...TENANCY_REF_IDS[ref.level].map((field) => refId(ref, field))];
}

function refId(ref: TenancyRef, field: string): string {
  return (ref as unknown as Readonly<Record<string, string>>)[field] ?? "";
}
