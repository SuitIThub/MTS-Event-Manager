type SharpFn = typeof import('sharp').default;

let cached: SharpFn | null | undefined;

/** Load sharp lazily so a missing native/wasm dep cannot block extension activate. */
export async function loadSharp(): Promise<SharpFn | null> {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const mod = await import('sharp');
    const fn =
      (mod as unknown as { default?: SharpFn }).default ?? (mod as unknown as SharpFn);
    cached = fn;
    return cached;
  } catch (e) {
    console.error('[MTS Event Manager] sharp failed to load', e);
    cached = null;
    return null;
  }
}
