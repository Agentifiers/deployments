import { createContext, use, type ReactNode } from "react";

/**
 * A layout route's header create button, handed to the list page in its outlet so an empty list
 * offers the same button. Undefined when the caller may not create, or outside such a layout.
 */
export const ListCreateAction = createContext<ReactNode>(undefined);

export function useListCreateAction(): ReactNode {
  return use(ListCreateAction);
}
