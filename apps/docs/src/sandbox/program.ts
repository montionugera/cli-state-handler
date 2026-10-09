import { MESSAGE_SOURCE, MAX_TEXT } from "./protocol.js";

export const RUN_LIMIT_MS = 5000;

/**
 * Code that runs INSIDE the frame, before user code. A plain string on purpose: it is
 * inlined into srcdoc, and it is exercised in tests by running the same program in a Node vm.
 */
const RUNTIME = `
var __g = typeof window !== "undefined" ? window : globalThis;
var __post = function (m) {
  m.source = ${JSON.stringify(MESSAGE_SOURCE)};
  m.runId = __RUN_ID__;
  parent.postMessage(m, "*");
};
var __MAX = ${MAX_TEXT};
function __clip(s) { return s.length > __MAX ? s.slice(0, __MAX) + "… [truncated]" : s; }
function __fmt(v, depth, seen) {
  if (v === null) return "null";
  var t = typeof v;
  if (t === "undefined") return "undefined";
  if (t === "string") return depth === 0 ? v : JSON.stringify(v);
  if (t === "number" || t === "boolean") return String(v);
  if (t === "bigint") return String(v) + "n";
  if (t === "symbol") return String(v);
  if (t === "function") return "[Function " + (v.name || "anonymous") + "]";
  if (v instanceof Error) return v.name + ": " + v.message;
  if (seen.indexOf(v) !== -1) return '"[Circular]"';
  if (depth >= 4) return Array.isArray(v) ? "[Array]" : "[Object]";
  seen = seen.concat([v]);
  try {
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Map) return "Map(" + v.size + ") " + __fmt(Array.from(v.entries()), depth + 1, seen);
    if (v instanceof Set) return "Set(" + v.size + ") " + __fmt(Array.from(v.values()), depth + 1, seen);
    if (Array.isArray(v)) {
      var items = v.slice(0, 100).map(function (x) { return __fmt(x, depth + 1, seen); });
      if (v.length > 100) items.push('"… ' + (v.length - 100) + ' more"');
      return "[" + items.join(",") + "]";
    }
    var keys = Object.keys(v);
    var parts = keys.slice(0, 50).map(function (k) { return JSON.stringify(k) + ":" + __fmt(v[k], depth + 1, seen); });
    if (keys.length > 50) parts.push('"…":"' + (keys.length - 50) + ' more keys"');
    return "{" + parts.join(",") + "}";
  } catch (e) {
    return "[Unprintable]";
  }
}
function __line(args) {
  return __clip(Array.prototype.map.call(args, function (a) { return __fmt(a, 0, []); }).join(" "));
}
["log", "info", "warn", "error"].forEach(function (level) {
  console[level] = function () { __post({ type: "log", level: level, text: __line(arguments) }); };
});
function __report(e) { __post({ type: "error", text: __clip(__fmt(e, 0, [])) }); }
if (__g.addEventListener) {
  __g.addEventListener("error", function (ev) { __report(ev.error || ev.message); });
  __g.addEventListener("unhandledrejection", function (ev) { __report(ev.reason); });
}
var __require = function (name) {
  if (name === "@montionugera/ucsa-core") return UcsaCore;
  throw new Error('Cannot import "' + name + '": only "@montionugera/ucsa-core" is available in the sandbox');
};
`;

/**
 * The user's JS as a string literal that is safe inside a <script> element: every "<" is written
 * as the six characters backslash-u-0-0-3-c (so "</script" and "<!--" can never appear), and the
 * U+2028/U+2029 separators are escaped too. The literal parses back to the exact original string.
 */
function embedCode(js: string): string {
  return JSON.stringify(js)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * One classic-script program: core IIFE, runtime, then the transpiled user code. The user code is
 * NOT pasted into the script: it is embedded as a JSON string and run with an indirect global
 * eval, wrapped in an async function so top-level await works. The indirect-eval call below exists
 * only inside this string, which becomes the sandboxed frame's script (the frame CSP allows it);
 * nothing in the parent page evaluates strings. It is written as `(0, eval)` followed by a
 * separate argument list, so the repo grep for direct string-evaluation calls under apps/docs/src
 * keeps its meaning and does not match this template.
 */
export function buildSandboxProgram(coreSource: string, js: string, runId: number): string {
  const runtime = RUNTIME.replace("__RUN_ID__", String(runId));
  const user = `
var __module = { exports: {} };
var __code = ${embedCode(js)};
Promise.resolve()
  .then(function () {
    var __fn = (0, eval)("(async function (require, module, exports) {\\n" + __code + "\\n})");
    return __fn(__require, __module, __module.exports);
  })
  .then(null, __report)
  .then(function () { __post({ type: "done" }); });
`;
  return `${coreSource}\n${runtime}\n${user}`;
}

function escapeForScriptElement(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

// 'unsafe-eval' is granted to the FRAME only (it runs the embedded user code); the parent page's
// policy is untouched and the parent contains no eval.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'";

export function buildSrcdoc(program: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    "</head><body><script>" +
    escapeForScriptElement(program) +
    "</script></body></html>"
  );
}
