import { deflateRawSync } from "node:zlib";
import { Zip, ZipPassThrough } from "fflate";

/** Deflates with native zlib: fflate's JavaScript deflate takes seconds over hundreds of MiB. */
class NativeDeflate extends ZipPassThrough {
  constructor(filename: string) {
    super(filename);
    this.compression = 8;
  }

  protected override process(chunk: Uint8Array<ArrayBuffer>, final: boolean) {
    this.ondata(null, deflateRawSync(chunk, { level: 9 }), final);
  }
}

/** A one-entry ZIP holding `bytes` zeros. */
export function zeroFilledZip(bytes: number) {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const entry = new NativeDeflate("zeros.txt");
  zip.add(entry);
  entry.push(new Uint8Array(bytes), true);
  zip.end();
  return new Uint8Array(Buffer.concat(chunks));
}
