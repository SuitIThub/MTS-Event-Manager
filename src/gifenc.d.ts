declare module 'gifenc' {
  export function GIFEncoder(opts?: { auto?: boolean }): {
    writeFrame: (
      index: Uint8Array | Uint8ClampedArray,
      width: number,
      height: number,
      opts?: {
        palette?: number[][] | Uint8Array;
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        dispose?: number;
      }
    ) => void;
    finish: () => void;
    bytes: () => Uint8Array;
    bytesView: () => Uint8Array;
  };
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: object
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array;
}
