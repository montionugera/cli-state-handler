export interface Preset {
  id: string;
  title: string;
  description: string;
  code: string;
}

export const presets: Preset[] = [
  {
    id: "first-query",
    title: "First query",
    description: "fetchQuery runs the function once; the second call is served from the cache while the entry is fresh.",
    code: `import { QueryEngine } from "@montionugera/ucsa-core";

const engine = new QueryEngine({ defaultStaleTime: 1000 });
let calls = 0;
const fetchUser = async () => {
  calls++;
  return { id: 1, name: "Ada" };
};

const first = await engine.fetchQuery(["user", 1], fetchUser);
console.log("first:", first);
const second = await engine.fetchQuery(["user", 1], fetchUser);
console.log("second (from cache):", second);
console.log("queryFn calls:", calls);
console.log("status:", engine.getQueryState(["user", 1])?.status);
`
  },
  {
    id: "swr-refetch",
    title: "Stale-while-revalidate",
    description:
      "A fetched entry is fresh until defaultStaleTime (1000 ms here) has passed since its fetch resolved, then stale. Reading a fresh entry returns the cached data with isFetching false and starts no fetch; reading a stale one returns the old data at once with isFetching true and refetches in the background. The fresh read happens right after the first fetch resolves, and the code waits for each fetch by subscribing to the query rather than sleeping, so only the one stale-time sleep depends on the clock (a throttled tab only makes it longer, which is still stale).",
    code: `import { QueryEngine } from "@montionugera/ucsa-core";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const engine = new QueryEngine({ defaultStaleTime: 1000 });
let version = 0;
const load = async () => ({ version: ++version });

// Resolve once the query has stopped fetching, by listening to the query itself.
const settled = (q: ReturnType<typeof engine.useQuery>) =>
  new Promise<void>((resolve) => {
    if (!q.getSnapshot().isFetching) return resolve();
    const off = q.subscribe(() => {
      if (q.getSnapshot().isFetching) return;
      off();
      resolve();
    });
  });

const query = engine.useQuery(["doc"], load);
await settled(query); // the first fetch resolves; stale_at is fixed now, 1000 ms ahead
console.log("1 loaded:", query.getSnapshot().data);

const fresh = engine.useQuery(["doc"], load); // read straight away: fresh, cached data, no refetch
console.log("2 fresh, fetching:", fresh.getSnapshot().isFetching);

await sleep(1100); // longer than the 1000 ms stale time; a slower timer is still stale
const stale = engine.useQuery(["doc"], load); // stale: old data returned, refetch starts
console.log("3 stale data served at once:", stale.getSnapshot().data, "fetching:", stale.getSnapshot().isFetching);

await settled(stale); // the background refetch resolves
console.log("4 after revalidation:", stale.getSnapshot().data);
`
  },
  {
    id: "debounce",
    title: "Debounce",
    description: "Rapid debounceQuery calls for the same key collapse into one queryFn run that all callers share.",
    code: `import { QueryEngine, debounceQuery } from "@montionugera/ucsa-core";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const engine = new QueryEngine();
let calls = 0;
let term = "";
const search = async () => {
  calls++;
  return \`results for "\${term}"\`;
};

const pending: Promise<string>[] = [];
for (const typed of ["t", "ty", "typ", "type"]) {
  term = typed;
  pending.push(debounceQuery(engine, ["search"], search, { debounceMs: 50 }));
  await sleep(10);
}

const results = await Promise.all(pending);
console.log("calls:", calls);
console.log("results:", results);
`
  },
  {
    id: "selector-observer",
    title: "Selector observer",
    description: "The observer notifies only when the selected slice (the name) changes, not when other fields do.",
    code: `import { QueryEngine, createSelectorObserver } from "@montionugera/ucsa-core";

type Profile = { name: string; visits: number };

const engine = new QueryEngine();
let current: Profile = { name: "Ada", visits: 1 };
const load = async () => current;

await engine.fetchQuery(["profile"], load);
const nameObserver = createSelectorObserver(engine, ["profile"], (p: Profile) => p.name, { queryFn: load });

let notifications = 0;
const stop = nameObserver.subscribe(() => {
  notifications++;
  console.log("name changed to", nameObserver.getSnapshot());
});
console.log("initial:", nameObserver.getSnapshot());

current = { name: "Ada", visits: 2 };
await engine.invalidateQueries(["profile"]);
console.log("after visits change, notifications:", notifications);

current = { name: "Grace", visits: 2 };
await engine.invalidateQueries(["profile"]);
console.log("after name change, notifications:", notifications);
stop();
`
  }
];
