import path from "node:path";

// The Joymify design system is unpublished: it is consumed from the sibling `joy-design` checkout.
const joy = (p: string) => path.resolve(import.meta.dirname, "../../../joy-design/packages", p);

export const joyAlias = {
  "@joymify/react": joy("react/src/index.ts"),
  "@joymify/icons/react": joy("icons/src/react.ts"),
  "@joymify/brand": joy("brand/src/index.js"),
  "@joymify/tokens/theme.css": joy("tokens/dist/theme.css")
};
