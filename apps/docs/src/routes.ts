// Docs page registry.
//
// To add a page (later slices): add ONE line to `routes` below plus your own
// component and CSS files (import the CSS from your component). Do not
// otherwise edit App.tsx or index.css - the shell, sidebar, router and
// not-found handling all derive from this array.
//
// Sidebar groups are derived from `group` in order of first appearance in
// `routes`, so a new group needs no edit outside this array.
//
// `component` is eager (not React.lazy) on purpose: the playground tests
// assert synchronously after a click.
import type { ComponentType } from "react";
import { Home } from "./pages/Home.js";
import { SwrPlayground } from "./components/SwrPlayground.js";
import { TimingPlayground } from "./components/TimingPlayground.js";
import { OutboxPlayground } from "./components/OutboxPlayground.js";
import { CasPlayground } from "./components/CasPlayground.js";
import { Ucb1Visualiser } from "./components/Ucb1Visualiser.js";
import { WalVisualiser } from "./components/WalVisualiser.js";
import { MultiPlatformDocs } from "./components/MultiPlatformDocs.js";
import { ParityMatrix } from "./components/ParityMatrix.js";
import { FirstQuery, Freshness, DurableCache, OfflineMutations, CrossProcess } from "./content/tutorial/index.js";
import { Sandbox } from "./components/Sandbox.js";

export interface RouteDef {
  /** Hash segment: the page lives at `#/<id>`. `home` is also served at `#/`. */
  id: string;
  title: string;
  icon?: string;
  /** Sidebar heading; any string. Groups are listed in order of first appearance. */
  group: string;
  component: ComponentType;
}

export const routes: RouteDef[] = [
  { id: "home", title: "Architecture Overview", icon: "📖", group: "Start", component: Home },
  { id: "tutorial-first-query", title: "1. Your First Query", icon: "🧭", group: "Tutorial", component: FirstQuery },
  { id: "tutorial-freshness", title: "2. Freshness and Refetch Timing", icon: "🕒", group: "Tutorial", component: Freshness },
  { id: "tutorial-durable-cache", title: "3. Durable Cache and WAL", icon: "🗄️", group: "Tutorial", component: DurableCache },
  { id: "tutorial-outbox", title: "4. Offline Mutations", icon: "📮", group: "Tutorial", component: OfflineMutations },
  { id: "tutorial-ucb1", title: "5. Cross-Process Events", icon: "📡", group: "Tutorial", component: CrossProcess },
  { id: "swr", title: "SWR & Lifecycle", icon: "⚡", group: "Visualisers", component: SwrPlayground },
  { id: "timing", title: "Timing & Rate-Limiting", icon: "⏱️", group: "Visualisers", component: TimingPlayground },
  { id: "outbox", title: "Offline Outbox & Conflict", icon: "📦", group: "Visualisers", component: OutboxPlayground },
  { id: "cas", title: "CAS Storage & LRU", icon: "💾", group: "Visualisers", component: CasPlayground },
  { id: "ucb1", title: "UCB1 Event Bus", icon: "🚌", group: "Visualisers", component: Ucb1Visualiser },
  { id: "wal", title: "WAL Storage", icon: "🪵", group: "Visualisers", component: WalVisualiser },
  { id: "multiplatform", title: "TS / Dart / Unity C#", icon: "🌐", group: "Guides", component: MultiPlatformDocs },
  { id: "parity", title: "Platform Parity Matrix", icon: "🧮", group: "Guides", component: ParityMatrix },
  { id: "sandbox", title: "TypeScript Sandbox", icon: "🧪", group: "Sandbox", component: Sandbox },
];

export const groups: string[] = [...new Set(routes.map((r) => r.group))];
