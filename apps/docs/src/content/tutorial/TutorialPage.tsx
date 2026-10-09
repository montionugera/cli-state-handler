import React from "react";
import { Prose } from "../../components/Prose.js";
import "./tutorial.css";

export interface TutorialPageProps {
  step: number;
  /** Prose before the embedded visualiser. */
  intro: React.ReactNode;
  /** The embedded visualiser(s). */
  visualiser: React.ReactNode;
  /** Prose after the visualiser. */
  after: React.ReactNode;
  next: { href: string; label: string };
}

/** Shared layout: prose, the visualiser at full width, more prose, then a link to the next page. */
export function TutorialPage({ step, intro, visualiser, after, next }: TutorialPageProps) {
  return (
    <div className="tut">
      <Prose>
        <p className="tut-step">Tutorial step {step} of 5</p>
        {intro}
      </Prose>
      <div className="tut-viz">{visualiser}</div>
      <Prose>{after}</Prose>
      <nav className="tut-next" aria-label="Tutorial navigation">
        <a href={next.href} data-next>
          {next.label}
        </a>
      </nav>
    </div>
  );
}
