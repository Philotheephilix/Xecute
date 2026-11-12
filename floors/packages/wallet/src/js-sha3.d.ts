declare module 'js-sha3' {
  /**
   * Compute SHA3-256 hash of data.
   * Returns lowercase hex string.
   */
  export function sha3_256(data: string | ArrayBuffer | Uint8Array): string;
  export function sha3_512(data: string | ArrayBuffer | Uint8Array): string;
  export function keccak256(data: string | ArrayBuffer | Uint8Array): string;
  export function keccak512(data: string | ArrayBuffer | Uint8Array): string;
}
