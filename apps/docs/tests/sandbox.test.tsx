// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within, waitFor } from "@testing-library/react";
import coreSource from "virtual:ucsa-core-iife";
import { App } from "../src/App.js";
import { Sandbox } from "../src/components/Sandbox.js";
import { routes } from "../src/routes.js";
import { transpile } from "../src/sandbox/transpile.js";
import { parseSandboxMessage } from "../src/sandbox/protocol.js";
import { buildSandboxProgram, buildSrcdoc } from "../src/sandbox/program.js";
import { presets } from "../src/sandbox/presets.js";
import { runProgramInVm } from "./sandbox-vm.js";

async function transpiled(code: string): Promise<string> {
  const r = await transpile(code);
  if (!r.ok) throw new Error(r.message);
  return r.js;
}

async function runCode(code: string): Promise<unknown[]> {
  return runProgramInVm(buildSandboxProgram(coreSource, await transpiled(code), 1));
}

function logs(messages: unknown[]): string[] {
  return messages.flatMap((m) =>
    typeof m === "object" && m !== null && (m as { type?: string }).type === "log" ? [(m as { text: string }).text] : []
  );
}

describe("transpile", () => {
  it("turns a typed snippet into runnable JavaScript", async () => {
    const js = await transpiled('const n: number = 2;\ninterface A { x: number }\nconsole.log("n", n as number);');
    expect(js).not.toContain(": number");
    expect(js).not.toContain("interface");
    expect(logs(await runProgramInVm(buildSandboxProgram(coreSource, js, 1)))).toEqual(["n 2"]);
  });

  it("reports a syntax error as a result instead of throwing", async () => {
    const r = await transpile("const = ;");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });
});

describe("frame program", () => {
  it("resolves import from @montionugera/ucsa-core against the inlined bundle and allows top-level await", async () => {
    const out = logs(
      await runCode('import { hashQueryKey } from "@montionugera/ucsa-core";\nawait Promise.resolve();\nconsole.log(typeof hashQueryKey);')
    );
    expect(out).toEqual(["function"]);
  });

  it("rejects imports of anything other than @montionugera/ucsa-core", async () => {
    const messages = await runCode('import fs from "fs";\nconsole.log(fs);');
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", text: expect.stringContaining("fs") }));
  });

  it("forwards console levels, and uncaught errors", async () => {
    const messages = await runCode(
      'console.info("i"); console.warn("w"); console.error("e");\nthrow new TypeError("boom");'
    );
    expect(messages).toContainEqual(expect.objectContaining({ type: "log", level: "info", text: "i" }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "log", level: "warn", text: "w" }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "log", level: "error", text: "e" }));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", text: "TypeError: boom" }));
    expect(messages[messages.length - 1]).toEqual(expect.objectContaining({ type: "done" }));
  });

  it("serialises cyclic objects, functions, errors and long output safely", async () => {
    const out = logs(
      await runCode(
        'const a: any = { n: 1 }; a.self = a;\nconsole.log(a);\nconsole.log(function foo() {});\nconsole.log(new Error("bad"));\nconsole.log(undefined, null, 5n, Symbol("s"));\nconsole.log("x".repeat(5000));'
      )
    );
    expect(out[0]).toBe('{"n":1,"self":"[Circular]"}');
    expect(out[1]).toBe("[Function foo]");
    expect(out[2]).toBe("Error: bad");
    expect(out[3]).toBe("undefined null 5n Symbol(s)");
    expect(out[4].length).toBeLessThan(2100);
    expect(out[4]).toContain("truncated");
  });

  it("srcdoc has the CSP meta, escapes script terminators and sets no network-capable markup", async () => {
    const program = buildSandboxProgram(coreSource, 'console.log("</script><script>alert(1)</script>");', 7);
    const doc = buildSrcdoc(program);
    expect(doc).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'">'
    );
    expect(doc.match(/<\/script/gi)?.length).toBe(1);
    expect(doc.endsWith("</script></body></html>")).toBe(true);
  });
});

const TRICKY: Array<{ name: string; ts: string; expected: string[] }> = [
  { name: "regex literal containing <!--", ts: 'console.log(/<!--/u.test("a<!--b"));', expected: ["true"] },
  { name: "String.raw template containing </script>", ts: "console.log(String.raw`</script>`.length);", expected: ["9"] },
  { name: "a</script/i (less-than against a regex literal)", ts: "const a = 1;\nconsole.log(a</script/i);", expected: ["false"] },
  { name: "x<!--b (HTML-like comment in sloppy scripts)", ts: "const x = 7;\nconst r = x<!--b\nconsole.log(r);", expected: ["7"] }
];

function embeddedCode(doc: string): string {
  const m = /var __code = (".*");\n/.exec(doc);
  if (!m) throw new Error("no embedded code literal in srcdoc");
  return JSON.parse(m[1]) as string;
}

describe("user code embedding (JSON string + indirect eval inside the frame)", () => {
  for (const c of TRICKY) {
    it(`round-trips through srcdoc unchanged and runs correctly: ${c.name}`, async () => {
      const js = await transpiled(c.ts);
      const doc = buildSrcdoc(buildSandboxProgram(coreSource, js, 1));
      expect(embeddedCode(doc)).toBe(js);
      expect(doc.match(/<\/script/gi)?.length).toBe(1);
      expect(logs(await runCode(c.ts))).toEqual(c.expected);
    });
  }

  it("escapes < and the U+2028/U+2029 separators in the embedded literal", async () => {
    const js = 'console.log("<b>\u2028\u2029");';
    const doc = buildSrcdoc(buildSandboxProgram(coreSource, js, 1));
    const literal = /var __code = (".*");\n/.exec(doc)?.[1] ?? "";
    expect(literal).not.toContain("<");
    expect(literal).not.toContain("\u2028");
    expect(literal).not.toContain("\u2029");
    expect(embeddedCode(doc)).toBe(js);
  });

  it("reports a user syntax error through the error channel and still finishes", async () => {
    const messages = await runProgramInVm(buildSandboxProgram(coreSource, "const = ;", 1));
    expect(messages).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(messages[messages.length - 1]).toEqual(expect.objectContaining({ type: "done" }));
  });

  it("allows unsafe-eval in the frame CSP only", () => {
    const doc = buildSrcdoc("");
    expect(doc).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(doc).toContain("default-src 'none'");
  });
});

describe("message validation", () => {
  const base = { source: "ucsa-sandbox", runId: 3 };
  it("accepts well-formed messages for the current run", () => {
    expect(parseSandboxMessage({ ...base, type: "log", level: "warn", text: "hi" }, 3)).toEqual({
      type: "log",
      level: "warn",
      text: "hi"
    });
    expect(parseSandboxMessage({ ...base, type: "error", text: "x" }, 3)).toEqual({ type: "error", text: "x" });
    expect(parseSandboxMessage({ ...base, type: "done" }, 3)).toEqual({ type: "done" });
  });
  it("rejects wrong run, wrong shape and wrong types", () => {
    expect(parseSandboxMessage({ ...base, type: "done" }, 4)).toBeNull();
    expect(parseSandboxMessage({ ...base, source: "other", type: "done" }, 3)).toBeNull();
    expect(parseSandboxMessage({ ...base, type: "log", level: "debug", text: "x" }, 3)).toBeNull();
    expect(parseSandboxMessage({ ...base, type: "log", level: "log", text: 5 }, 3)).toBeNull();
    expect(parseSandboxMessage({ ...base, type: "nope" }, 3)).toBeNull();
    expect(parseSandboxMessage("string", 3)).toBeNull();
    expect(parseSandboxMessage(null, 3)).toBeNull();
  });
  it("truncates very long text", () => {
    const m = parseSandboxMessage({ ...base, type: "log", level: "log", text: "y".repeat(20000) }, 3);
    expect(m && m.type === "log" && m.text.length).toBeLessThan(2100);
  });
});

const EXPECTED: Record<string, string[]> = {
  "first-query": ['first: {"id":1,"name":"Ada"}', 'second (from cache): {"id":1,"name":"Ada"}', "queryFn calls: 1", "status: success"],
  "swr-refetch": [
    '1 loaded: {"version":1}',
    "2 fresh, fetching: false",
    '3 stale data served at once: {"version":1} fetching: true',
    '4 after revalidation: {"version":2}'
  ],
  debounce: ["calls: 1", 'results: ["results for \\"type\\"","results for \\"type\\"","results for \\"type\\"","results for \\"type\\""]'],
  "selector-observer": [
    "initial: Ada",
    "after visits change, notifications: 0",
    "name changed to Grace",
    "after name change, notifications: 1"
  ]
};

describe("presets", () => {
  it("has at least four presets with unique ids", () => {
    expect(presets.length).toBeGreaterThanOrEqual(4);
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length);
    for (const id of Object.keys(EXPECTED)) expect(presets.map((p) => p.id)).toContain(id);
  });

  for (const id of Object.keys(EXPECTED)) {
    it(`preset ${id} transpiles and runs against the real core with the expected output`, async () => {
      const preset = presets.find((p) => p.id === id);
      if (!preset) throw new Error("missing preset " + id);
      const messages = await runCode(preset.code);
      expect(messages.filter((m) => (m as { type: string }).type === "error")).toEqual([]);
      expect(logs(messages)).toEqual(EXPECTED[id]);
    });
  }

  it("every preset transpiles", async () => {
    for (const p of presets) expect((await transpile(p.code)).ok, p.id).toBe(true);
  });
});

function setHash(h: string) {
  window.location.hash = h;
}

function frame(): HTMLIFrameElement {
  const el = document.querySelector("iframe");
  if (!el) throw new Error("no iframe");
  return el as HTMLIFrameElement;
}

function post(source: Window | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

describe("Sandbox page", () => {
  beforeEach(() => setHash("#/sandbox"));
  afterEach(() => cleanup());

  it("is registered in a Sandbox sidebar group and renders a heading inside main", () => {
    expect(routes.find((r) => r.id === "sandbox")?.group).toBe("Sandbox");
    render(<App />);
    expect(within(screen.getByRole("main")).getByRole("heading", { level: 1 })).toBeTruthy();
  });

  it("states that Dart and C# are read-only", () => {
    render(<Sandbox />);
    expect(screen.getByText(/Dart and C# examples .* read-only/i)).toBeTruthy();
  });

  it("shows no frame before Run, then a frame with sandbox=allow-scripts exactly", async () => {
    render(<Sandbox />);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("shows a syntax error in the error panel without throwing and without a frame", async () => {
    render(<Sandbox />);
    const editor = screen.getByLabelText("TypeScript source");
    fireEvent.change(editor, { target: { value: "const = ;" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    const panel = await screen.findByRole("alert");
    expect(panel.textContent).toMatch(/error/i);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("ignores messages from other sources and shows messages from its own frame in the live region", async () => {
    render(<Sandbox />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const runId = Number(frame().getAttribute("data-run-id"));
    const msg = { source: "ucsa-sandbox", runId, type: "log", level: "log", text: "from-frame" };
    const consoleEl = screen.getByRole("log");
    expect(consoleEl.getAttribute("aria-live")).toBe("polite");

    post(window, { ...msg, text: "from-foreign" });
    expect(consoleEl.textContent).not.toContain("from-foreign");

    post(frame().contentWindow, { ...msg, text: "malformed", level: "debug" });
    expect(consoleEl.textContent).not.toContain("malformed");

    post(frame().contentWindow, msg);
    expect(consoleEl.textContent).toContain("from-frame");

    post(frame().contentWindow, { source: "ucsa-sandbox", runId, type: "error", text: "TypeError: boom" });
    expect(screen.getByRole("alert").textContent).toContain("TypeError: boom");
  });

  it("uses a fresh frame for every run and ends a run that exceeds the limit by replacing the frame", async () => {
    render(<Sandbox limitMs={500} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const first = frame();
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());
    expect(screen.getByRole("alert").textContent).toMatch(/ended after/i);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(frame()).not.toBe(first);
  });

  it("selects the preset named in the URL and updates the hash when a preset is chosen", () => {
    setHash("#/sandbox?preset=debounce");
    render(<Sandbox />);
    const editor = screen.getByLabelText("TypeScript source") as HTMLTextAreaElement;
    expect(editor.value).toBe(presets.find((p) => p.id === "debounce")?.code);
    expect(screen.getByRole("button", { name: /Debounce/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /Selector observer/ }));
    expect(window.location.hash).toBe("#/sandbox?preset=selector-observer");
    expect(editor.value).toBe(presets.find((p) => p.id === "selector-observer")?.code);
  });

  it("follows hash changes (deep link while already on the page)", () => {
    render(<Sandbox />);
    act(() => {
      setHash("#/sandbox?preset=swr-refetch");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const editor = screen.getByLabelText("TypeScript source") as HTMLTextAreaElement;
    expect(editor.value).toBe(presets.find((p) => p.id === "swr-refetch")?.code);
  });

  it("Tab inserts two spaces; Escape then Tab leaves the editor alone", () => {
    render(<Sandbox />);
    const editor = screen.getByLabelText("TypeScript source") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "ab" } });
    editor.setSelectionRange(1, 1);
    expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(false); // default prevented
    expect(editor.value).toBe("a  b");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(fireEvent.keyDown(editor, { key: "Tab" })).toBe(true); // not prevented: focus moves on
    expect(editor.value).toBe("a  b");
  });

  it("renders one line-number per line and follows edits", () => {
    render(<Sandbox />);
    const editor = screen.getByLabelText("TypeScript source");
    fireEvent.change(editor, { target: { value: "a\nb\nc" } });
    expect(document.querySelectorAll(".sbx-gutter-line").length).toBe(3);
  });

  it("keeps Stop enabled while a frame exists, even after the run reported done", async () => {
    render(<Sandbox limitMs={60000} />);
    const stopBtn = screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement;
    expect(stopBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const runId = Number(frame().getAttribute("data-run-id"));
    post(frame().contentWindow, { source: "ucsa-sandbox", runId, type: "done" });
    expect(screen.getByRole("status").textContent).toMatch(/finished/i);
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(stopBtn.disabled).toBe(false);
    fireEvent.click(stopBtn);
    expect(document.querySelector("iframe")).toBeNull();
    expect(stopBtn.disabled).toBe(true);
  });

  it("caps retained error entries at 50", async () => {
    render(<Sandbox limitMs={60000} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const runId = Number(frame().getAttribute("data-run-id"));
    for (let i = 0; i < 80; i++) {
      post(frame().contentWindow, { source: "ucsa-sandbox", runId, type: "error", text: `err-${i}` });
    }
    const items = document.querySelectorAll(".sbx-error-text");
    expect(items.length).toBe(50);
    expect(items[49].textContent).toBe("err-79");
    expect(items[0].textContent).toBe("err-30");
  });

  it("ends a run with a visible message after 2000 messages", async () => {
    render(<Sandbox limitMs={60000} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const runId = Number(frame().getAttribute("data-run-id"));
    const win = frame().contentWindow;
    act(() => {
      for (let i = 0; i < 2001; i++) {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { source: "ucsa-sandbox", runId, type: "log", level: "log", text: `m${i}` },
            source: win
          })
        );
      }
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/2000 messages/);
    expect(screen.getByRole("status").textContent).toMatch(/stopped/i);
  });

  it("counts malformed messages toward the cap, so they cannot bypass it", async () => {
    render(<Sandbox limitMs={60000} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const win = frame().contentWindow;
    act(() => {
      for (let i = 0; i < 2001; i++) {
        window.dispatchEvent(new MessageEvent("message", { data: "x".repeat(100), source: win }));
      }
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/2000 messages/);
  });

  it("ends the run when the frame loads a second document (navigated away)", async () => {
    render(<Sandbox limitMs={60000} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    // jsdom fires the srcdoc document's own load event; a frame that is still present has seen exactly that one.
    expect(document.querySelector("iframe")).not.toBeNull();
    fireEvent.load(frame());
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/navigated away from the sandbox document/);
    expect(screen.getByRole("status").textContent).toMatch(/stopped/i);
  });

  it("stops the frame and clears the console when the hash switches to a different preset mid-run", async () => {
    render(<Sandbox limitMs={60000} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    const runId = Number(frame().getAttribute("data-run-id"));
    post(frame().contentWindow, { source: "ucsa-sandbox", runId, type: "log", level: "log", text: "old-output" });
    expect(screen.getByRole("log").textContent).toContain("old-output");
    act(() => {
      setHash("#/sandbox?preset=swr-refetch");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("log").textContent).not.toContain("old-output");
    expect(screen.getByRole("status").textContent).toMatch(/ready/i);
  });

  it("shows the infinite-loop warning next to the Run button", () => {
    render(<Sandbox />);
    const actions = screen.getByRole("button", { name: "Run" }).parentElement as HTMLElement;
    expect(actions.textContent).toMatch(/synchronous infinite loop can freeze the tab/i);
  });

  it("describes the isolation accurately, without claiming all network requests are blocked", () => {
    render(<Sandbox />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("no access to this page, its storage or its origin");
    expect(text).toContain("blocks direct fetch, XMLHttpRequest and WebSocket calls");
    expect(text).toContain("not a full network-isolation guarantee");
    expect(text).not.toMatch(/blocks network requests/i);
  });
});
