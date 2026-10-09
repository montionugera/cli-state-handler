import React from "react";
import "../prose.css";

/** Prose page primitive: styles h1-h3, p, ul/ol, inline code and links for tutorial content. */
export function Prose({ children }: { children: React.ReactNode }) {
  return <article className="prose">{children}</article>;
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <aside className={`prose-callout prose-callout--${tone}`}>
      {title && <strong className="prose-callout__title">{title}</strong>}
      <div>{children}</div>
    </aside>
  );
}

export function CodeBlock({ children, language }: { children: string; language?: string }) {
  return (
    <pre className="prose-code" data-language={language}>
      <code>{children}</code>
    </pre>
  );
}
