declare module 'heic-decode' {
  interface DecodeInput {
    buffer: Buffer | Uint8Array;
  }

  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  const decode: (input: DecodeInput) => Promise<DecodedImage>;

  export = decode;
}
