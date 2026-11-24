import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fades the edge of a `Table` that has columns scrolled out of view, so a narrow screen shows
 * there is more to swipe to. `Table` already scrolls sideways inside its own container; this
 * watches that container and draws the fade only on a side with hidden columns.
 */
export function ScrollCue({ children }: Readonly<{ children: ReactNode }>) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState({ end: false, start: false });
  useEffect(() => {
    const scroller = ref.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!scroller) return;
    const update = () => {
      const overflow = scroller.scrollWidth - scroller.clientWidth;
      setHidden({
        end: scroller.scrollLeft < overflow - 1,
        start: scroller.scrollLeft > 1,
      });
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    // The table grows as rows load; the container narrows with the viewport.
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return (
    <div className="relative" ref={ref}>
      {children}
      {hidden.start ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8 bg-linear-to-r from-background to-transparent"
        />
      ) : null}
      {hidden.end ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-linear-to-l from-background to-transparent"
        />
      ) : null}
    </div>
  );
}
