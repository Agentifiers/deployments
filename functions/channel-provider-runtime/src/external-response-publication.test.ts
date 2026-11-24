import { describe, expect, test } from "bun:test";
import { ConversationError } from "@deployments-ai/conversations";

import { isMissingExternalPublicationReservation } from "./external-response-publication.ts";

describe("external response publication release classification", () => {
  test("treats only an absent reservation as an idempotent release", () => {
    expect(
      isMissingExternalPublicationReservation(
        new ConversationError("publication_not_reserved", "Reservation was not found."),
      ),
    ).toBe(true);
    expect(
      isMissingExternalPublicationReservation(
        new ConversationError(
          "publication_unavailable",
          "A confirmed delivery must finish publication.",
        ),
      ),
    ).toBe(false);
    expect(isMissingExternalPublicationReservation(new Error("storage unavailable"))).toBe(false);
  });
});
