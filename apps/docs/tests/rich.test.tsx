// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor, configure } from "@testing-library/react";
import { Code, Diagram } from "../src/components/rich.js";
import { Callout, CodeBlock } from "../src/components/Prose.js";
// The lazy Joymify chunk can take over a second to load on a busy machine.
configure({ asyncUtilTimeout: 5000 });
const FLOW = "flowchart LR\n  A[Cache] --> B[Network]";
describe("Joymify code and diagram components", () => {
  afterEach(() => cleanup());
  it("shows the plain code first, then Joymify highlight spans", async () => {
    const { container } = render(<Code code={"const a = 1; // note"} language="typescript" />);
    expect(container.textContent).toContain("const a = 1; // note");
    expect(container.querySelector(".rich-fallback")).not.toBeNull();
    await waitFor(() => expect(container.querySelector('[class^="joy-syntax-"]')).not.toBeNull());
    expect(container.querySelector(".joy-code-block")).not.toBeNull();
  });
  it("draws a flowchart as an svg", async () => {
    const { container } = render(<Diagram code={FLOW} />);
    await waitFor(() => expect(container.querySelector("svg.joy-mermaid__svg")).not.toBeNull());
    expect(container.querySelector("svg.joy-mermaid__svg")?.textContent).toContain("Network");
  });
  it("shows the source of a definition the renderer rejects, and does not throw", async () => {
    const { container } = render(<Diagram code="sequenceDiagram" />);
    await waitFor(() => expect(container.querySelector(".joy-mermaid__source")).not.toBeNull());
    expect(container.querySelector("svg.joy-mermaid__svg")).toBeNull();
    expect(container.querySelector(".joy-mermaid__source")?.textContent).toContain("sequenceDiagram");
  });
  it("Prose CodeBlock renders through the Joymify CodeBlock", async () => {
    const { container } = render(<CodeBlock language="typescript">{"const b = 2;"}</CodeBlock>);
    await waitFor(() => expect(container.querySelector(".joy-code-block.prose-code")).not.toBeNull());
  });
  it("Prose Callout is a Joymify Alert that is not announced as an alert", () => {
    const { container } = render(<Callout tone="warn" title="Careful">Body text</Callout>);
    const alert = container.querySelector(".joy-alert.joy-alert--warning");
    expect(alert?.getAttribute("role")).toBe("note");
    expect(alert?.textContent).toContain("Careful");
    expect(alert?.textContent).toContain("Body text");
    expect(render(<Callout>Info</Callout>).container.querySelector(".joy-alert--info")).not.toBeNull();
  });
});
