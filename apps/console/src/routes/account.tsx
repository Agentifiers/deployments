import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../components/account/account-page.tsx";
import {
  accountProfileQuery,
  accountSecurityQuery,
  accountSessionsQuery,
} from "../data/account-queries.ts";

export const Route = createFileRoute("/account")({
  component: AccountPage,
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(accountSecurityQuery()),
      context.queryClient.prefetchQuery(accountProfileQuery()),
      context.queryClient.prefetchInfiniteQuery(accountSessionsQuery()),
    ]);
  },
});
