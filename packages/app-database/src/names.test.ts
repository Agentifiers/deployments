import { expect, test } from "bun:test";
import { Schema } from "effect";
import { AppId, appDatabaseNames, appRoleList } from "./names.ts";

test("an app has one database and four login roles named from its id", () => {
  const names = appDatabaseNames(Schema.decodeUnknownSync(AppId)("01J9Z3NDEKTSV4RRFFQ69G5FAV"));
  expect<unknown>({ names, roles: appRoleList(names) }).toEqual({
    names: {
      database: "app_01j9z3ndektsv4rrffq69g5fav",
      roles: {
        editor: "app_01j9z3ndektsv4rrffq69g5fav_editor",
        owner: "app_01j9z3ndektsv4rrffq69g5fav_owner",
        viewer: "app_01j9z3ndektsv4rrffq69g5fav_viewer",
        visitor: "app_01j9z3ndektsv4rrffq69g5fav_visitor",
      },
    },
    roles: [
      "app_01j9z3ndektsv4rrffq69g5fav_owner",
      "app_01j9z3ndektsv4rrffq69g5fav_editor",
      "app_01j9z3ndektsv4rrffq69g5fav_viewer",
      "app_01j9z3ndektsv4rrffq69g5fav_visitor",
    ],
  });
});
