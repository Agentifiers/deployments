import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { withClient } from "@/components/ui/render-client";

function RotateDialog() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Rotate</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} size="2xl">
          <DialogTitle>Rotate key</DialogTitle>
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("DialogContent", () => {
  test("opens with its size and viewport scroll classes, and closes", async () => {
    const steps: unknown[] = [];
    await withClient(<RotateDialog />, async (view) => {
      const content = () => view.document.querySelector('[data-slot="dialog-content"]');
      const button = (text: string) =>
        [...view.document.querySelectorAll("button")].find((node) => node.textContent === text);
      steps.push(content() === null);
      await view.click(button("Rotate"));
      const names = content()?.className.split(" ") ?? [];
      steps.push(
        content()?.querySelector("h2")?.textContent,
        ["sm:max-w-2xl", "max-h-[calc(100dvh-2rem)]", "overflow-y-auto"].map((name) =>
          names.includes(name),
        ),
      );
      await view.click(button("Cancel"));
      steps.push(content()?.getAttribute("data-closed") !== null || content() === null);
    });
    expect(steps).toEqual([true, "Rotate key", [true, true, true], true]);
  });
});
