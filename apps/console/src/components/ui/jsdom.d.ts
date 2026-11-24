// @types/jsdom pulls lib "dom" into vitest's types and breaks packages/e2e's fetch typing.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window & typeof globalThis;
  }
}
