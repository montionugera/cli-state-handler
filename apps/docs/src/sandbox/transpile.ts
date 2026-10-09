export type TranspileResult = { ok: true; js: string } | { ok: false; message: string };

/**
 * TypeScript -> JavaScript via sucrase (`imports` turns `import` into `require`, which the
 * frame shims for "@montionugera/ucsa-core"). sucrase is loaded on first use so it stays out of the entry chunk.
 */
export async function transpile(code: string): Promise<TranspileResult> {
  try {
    const { transform } = await import("sucrase");
    const { code: js } = transform(code, { transforms: ["typescript", "imports"] });
    return { ok: true, js };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
