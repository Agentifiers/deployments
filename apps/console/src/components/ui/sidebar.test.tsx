import { describe, expect, test } from "bun:test";
import { withClient } from "@/components/ui/render-client";
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

describe("SidebarProvider", () => {
  test("toggles open state in React without writing a cookie", async () => {
    const seen: unknown[] = [];
    await withClient(
      <SidebarProvider>
        <Sidebar>
          <SidebarContent />
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
      async (view) => {
        const state = () =>
          view.document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state");
        seen.push(state());
        await view.click(view.document.querySelector('[data-sidebar="trigger"]'));
        seen.push(state(), view.document.cookie);
      },
    );
    expect(seen).toEqual(["expanded", "collapsed", ""]);
  });
});
