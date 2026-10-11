import React, { Suspense, lazy } from "react";
import type { CodeBlockProps, MermaidViewerProps, PolyglotCodeTabsProps } from "@montionugera/joy-react";
import "./rich.css";
// One dynamic import for all three, so the highlighter and the diagram renderer
// stay out of the entry chunk. Everything else imports from this module.
const load = () => import("./rich-impl.js");
const LazyCodeBlock = lazy(() => load().then((m) => ({ default: m.CodeBlock })));
const LazyCodeTabs = lazy(() => load().then((m) => ({ default: m.PolyglotCodeTabs })));
const LazyMermaid = lazy(() => load().then((m) => ({ default: m.MermaidViewer })));
function Plain({ code }: { code: string }) {
  return (
    <pre className="rich-fallback">
      <code>{code}</code>
    </pre>
  );
}
export function Code(props: CodeBlockProps) {
  return (
    <Suspense fallback={<Plain code={props.code ?? ""} />}>
      <LazyCodeBlock {...props} />
    </Suspense>
  );
}
export function CodeTabs(props: PolyglotCodeTabsProps) {
  const items = props.items ?? [];
  const active = items.find((item) => (item.key || item.language) === props.activeKey) ?? items[0];
  return (
    <Suspense fallback={<Plain code={active?.code ?? ""} />}>
      <LazyCodeTabs {...props} />
    </Suspense>
  );
}
export function Diagram(props: MermaidViewerProps) {
  return (
    <Suspense fallback={<Plain code={props.code ?? ""} />}>
      <LazyMermaid {...props} />
    </Suspense>
  );
}
