import React from "react";
import { Alert } from "@montionugera/joy-react";
import { Code } from "./rich.js";
import "../prose.css";
/** Prose page primitive: styles h1-h3, p, ul/ol, inline code and links for tutorial content. */
export function Prose({ children }: { children: React.ReactNode }) {
  return <article className="prose">{children}</article>;
}
/** A static note. `role="note"` replaces the Alert's default `role="alert"`, which would be announced on load. */
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
    <Alert className="prose-callout" role="note" variant={tone === "warn" ? "warning" : "info"} title={title}>
      {children}
    </Alert>
  );
}
export function CodeBlock({ children, language }: { children: string; language?: string }) {
  return <Code className="prose-code" code={children} language={language} />;
}
