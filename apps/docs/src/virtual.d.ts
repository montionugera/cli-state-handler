declare module "virtual:ucsa-core-iife" {
  /** @montionugera/ucsa-core browser entry bundled as an IIFE defining the global `UcsaCore`. */
  const source: string;
  export default source;
}

declare module "*.md?raw" {
  const text: string;
  export default text;
}
