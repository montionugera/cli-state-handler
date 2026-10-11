import React, { useState } from "react";
import { Segmented } from "@montionugera/joy-react";
import { applyTheme, readTheme, type ThemeChoice } from "../theme.js";
const OPTIONS = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <Segmented
      className="theme-toggle"
      aria-label="Theme"
      size="sm"
      options={OPTIONS}
      value={choice}
      onChange={(value) => {
        const next: ThemeChoice = value === "light" || value === "dark" ? value : "system";
        applyTheme(next);
        setChoice(next);
      }}
    />
  );
}
