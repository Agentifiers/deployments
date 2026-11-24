import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { makeAdministrationContext } from "../identity-federation/administration-context.ts";
import { makeDirectoryAdministration, type DirectoryAdministration } from "./administration.ts";
import { makeDirectoryReads } from "./reads.ts";
import { makeDirectoryUsers, type DirectoryUsers } from "./users.ts";

export {
  DIRECTORY_TOKEN_PREFIX,
  type DirectoryAdministrator,
  type DirectoryCaller,
  type DirectorySettings,
  type DirectoryTokenSummary,
  type IssuedDirectoryToken,
} from "./administration.ts";
export type { DirectoryUserAttribute } from "./reads.ts";
export type { DirectoryRefusal, DirectoryUserChange, NewDirectoryUser } from "./user-plan.ts";
export {
  DirectoryContentionError,
  type DirectoryResult,
  type DirectoryUser,
  type DirectoryUserPage,
  type DirectoryUserQuery,
  type DirectoryUsers,
} from "./users.ts";
export type { DirectoryRole } from "../records/directory.ts";

export interface Directory extends DirectoryAdministration {
  readonly users: DirectoryUsers;
}

export function makeDirectory(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
  readonly randomSecret?: () => string;
}): Directory {
  const context = makeAdministrationContext(dependencies);
  const reads = makeDirectoryReads(dependencies.database);
  return {
    ...makeDirectoryAdministration(context, reads, dependencies.randomSecret),
    users: makeDirectoryUsers(context, reads),
  };
}
