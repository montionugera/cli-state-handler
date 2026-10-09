import React from "react";
import { Prose, Callout } from "../components/Prose.js";

export function NotFound() {
  return (
    <Prose>
      <h1>Page not found</h1>
      <Callout tone="warn" title="No page at this address">
        The link may be out of date. Pick a page from the sidebar, or go back to the{" "}
        <a href="#/">overview</a>.
      </Callout>
    </Prose>
  );
}
