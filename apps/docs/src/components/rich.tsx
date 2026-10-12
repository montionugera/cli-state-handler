import React, { Suspense, lazy } from "react";
import type { CodeBlockProps, MermaidViewerProps, PolyglotCodeTabsProps } from "@montionugera/joy-react";
import "./rich.css";
// One dynamic import for all three, so the highlighter and the diagram renderer
// stay out of the entry chunk. Everything else imports from this module.
const load = () => import("./rich-impl.js");
const LazyCodeBlock = lazy(() => load().then((m) => ({ default: m.CodeBlock })));
const LazyCodeTabs = lazy(() => load().then((m) => ({ default: m.PolyglotCodeTabs })));
const LazyMermaid = lazy(() => load().then((m) => ({ default: m.MermaidViewer })));
function Plain({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={className ? `rich-fallback ${className}` : "rich-fallback"}>
      <code>{code}</code>
    </pre>
  );
}
/** If the lazy chunk fails to load (stale tab after a redeploy, offline), show the plain text instead of unmounting the page. */
class ChunkBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function Code(props: CodeBlockProps) {
  const plain = <Plain code={props.code ?? ""} className={props.className} />;
  return (
    <ChunkBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <LazyCodeBlock {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
export function CodeTabs(props: PolyglotCodeTabsProps) {
  const items = props.items ?? [];
  const wanted = props.activeKey ?? props.defaultActiveKey;
  const active = items.find((item) => (item.key || item.language) === wanted) ?? items[0];
  const plain = <Plain code={active?.code ?? ""} />;
  return (
    <ChunkBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <LazyCodeTabs {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
export function Diagram(props: MermaidViewerProps) {
  const plain = <Plain code={props.code ?? ""} className={props.className} />;
  return (
    <ChunkBoundary fallback={plain}>
      <Suspense fallback={plain}>
        <LazyMermaid {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
