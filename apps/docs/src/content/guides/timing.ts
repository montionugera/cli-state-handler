import { CORE, DART, CS, type Guide } from "./types.js";

export const timing: Guide = {
  id: "timing",
  label: "Timing Controls",
  ts: {
    title: "Debounce and Throttle (TypeScript)",
    lang: "typescript",
    available: true,
    sources: [`${CORE}/query/query-engine.ts`, `${CORE}/consumer/observer.ts`],
    code: `// Checked against: packages/core/src/query/query-engine.ts (fetchQuery debounceMs),
// packages/core/src/consumer/observer.ts (createSelectorObserver)
import { createSelectorObserver } from "@ucsa/core";

// 1. Observer: limit how often listeners are told about the selected slice.
const fpsObserver = createSelectorObserver(
  engine,
  ["system", "telemetry"],
  (data: { fps: number }) => data.fps,
  { throttleMs: 100 }
);

// 2. Query: calls within debounceMs reset one timer and share the single result.
export function search(term: string) {
  return engine.fetchQuery(
    ["search", term],
    async ({ signal }) => (await fetch("/api/search?q=" + term, { signal })).json(),
    { debounceMs: 300 }
  );
}`,
    notes: [
      "debounceMs applies to calls with the same query key: each call resets the timer and all callers receive the final result. A fresh cached entry short-circuits before the debounce.",
      "debounceQuery(engine, key, fn, { debounceMs }) is a thin wrapper over fetchQuery.",
      "Observers accept throttleMs and debounceMs, and an isEqual comparer.",
    ],
  },
  dart: {
    title: "Debounce and Throttle (Dart / Flutter)",
    lang: "dart",
    available: true,
    sources: [`${DART}/query_engine.dart`, `${DART}/selector_observer.dart`],
    code: `// Checked against: packages/ucsa_dart/lib/src/query_engine.dart (fetchQuery debounceDuration),
// packages/ucsa_dart/lib/src/selector_observer.dart (SelectorObserver)
import 'package:ucsa_dart/ucsa_dart.dart';

final fps = SelectorObserver<Map<String, dynamic>, int>(
  engine: engine,
  queryKey: ['system', 'telemetry'],
  selector: (data) => data['fps'] as int,
  throttleDuration: const Duration(milliseconds: 100),
);
final stop = fps.subscribe(() => print(fps.value));

// fetchSearch is your own function.
Future<List<dynamic>> search(String term) => engine.fetchQuery<List<dynamic>>(
      ['search', term],
      () => fetchSearch(term),
      debounceDuration: const Duration(milliseconds: 300),
    );`,
    notes: [
      "Parameter names are throttleDuration and debounceDuration (Duration values).",
      "SelectorObserver exposes getSnapshot(), a stream and a value getter. The stream emits only while at least one subscribe() listener is attached.",
    ],
  },
  csharp: {
    title: "Debounce and Throttle (C# Unity)",
    lang: "csharp",
    available: true,
    sources: [`${CS}/Core/QueryEngine.cs`, `${CS}/Core/StateObserver.cs`],
    code: `// Checked against: Runtime/Core/QueryEngine.cs (DebounceQueryAsync),
// Runtime/Core/StateObserver.cs (StateObserver constructor, Update, OnValueChanged)
using Ucsa.Unity.Core;

// Observer fed by you: call Update with each new full state.
var fps = new StateObserver<Telemetry, int>(t => t.Fps, throttleMs: 100);
fps.OnValueChanged += value => Debug.Log(value);
fps.Update(latestTelemetry);

// Debounced query: debounceMs is a positional argument.
var results = await engine.DebounceQueryAsync<SearchResponse>(
    new object[] { "search", term },
    ct => SearchAsync(term, ct),
    debounceMs: 300);`,
    notes: [
      "StateObserver is not subscribed to the engine by itself; the caller passes data to Update (Update returns true when the selected value changed; with debounceMs the notification fires later).",
      "Telemetry, SearchResponse and SearchAsync are your own types.",
    ],
  },
};
