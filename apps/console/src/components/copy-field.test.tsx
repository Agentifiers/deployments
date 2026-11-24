import { expect, test } from "bun:test";
import { act } from "react";
import { withClient } from "@/components/ui/render-client";
import { Toaster } from "@/components/ui/sonner";
import { CopyField } from "./copy-field.tsx";

test("a rejected clipboard write tells the user to copy the value by hand", async () => {
  await withClient(
    <>
      <CopyField label="Client ID" value="abc-123" />
      <Toaster />
    </>,
    async ({ document, click }) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      await click(document.querySelector('[aria-label="Copy the client id"]'));
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(document.body.textContent).toContain("Copying failed. Select the value and copy it.");
    },
  );
});
