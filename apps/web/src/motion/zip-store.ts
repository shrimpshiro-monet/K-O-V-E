export interface ZipStoreEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

export function createStoredZip(
  entries: readonly ZipStoreEntry[],
): Uint8Array<ArrayBuffer> {
  if (!Array.isArray(entries)) {
    throw new Error("createStoredZip: entries must be an array");
  }

  const LOCAL_HEADER_SIZE = 30;
  const CENTRAL_HEADER_SIZE = 46;
  const END_RECORD_SIZE = 22;

  if (entries.length > 0xffff) throw new Error("createStoredZip: ZIP32 supports at most 65,535 entries");
  const prepared: PreparedEntry[] = [];
  let localSectionSize = 0;
  for (const entry of entries) {
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      throw new Error("createStoredZip: entry name must be a non-empty string");
    }
    if (!(entry.data instanceof Uint8Array)) {
      throw new Error("createStoredZip: entry data must be a Uint8Array");
    }
    const nameBytes = encodeName(entry.name);
    if (nameBytes.length > 0xffff || entry.data.length > 0xffffffff) {
      throw new Error("createStoredZip: entry exceeds ZIP32 limits");
    }
    prepared.push({
      nameBytes,
      data: entry.data,
      crc: crc32(entry.data),
      localHeaderOffset: localSectionSize,
    });
    localSectionSize += LOCAL_HEADER_SIZE + nameBytes.length + entry.data.length;
  }

  let centralSectionSize = 0;
  for (const entry of prepared) {
    centralSectionSize += CENTRAL_HEADER_SIZE + entry.nameBytes.length;
  }

  const totalSize = localSectionSize + centralSectionSize + END_RECORD_SIZE;
  if (totalSize > 0xffffffff) throw new Error("createStoredZip: archive exceeds ZIP32's 4 GB limit");
  const backing = new ArrayBuffer(totalSize);
  const buffer = new Uint8Array(backing);
  const view = new DataView(backing);

  let cursor = 0;
  for (const entry of prepared) {
    writeUint32(view, cursor, 0x04034b50);
    writeUint16(view, cursor + 4, 20);
    writeUint16(view, cursor + 6, 0);
    writeUint16(view, cursor + 8, 0);
    writeUint16(view, cursor + 10, 0);
    writeUint16(view, cursor + 12, 0);
    writeUint32(view, cursor + 14, entry.crc);
    writeUint32(view, cursor + 18, entry.data.length);
    writeUint32(view, cursor + 22, entry.data.length);
    writeUint16(view, cursor + 26, entry.nameBytes.length);
    writeUint16(view, cursor + 28, 0);
    buffer.set(entry.nameBytes, cursor + LOCAL_HEADER_SIZE);
    buffer.set(entry.data, cursor + LOCAL_HEADER_SIZE + entry.nameBytes.length);
    cursor += LOCAL_HEADER_SIZE + entry.nameBytes.length + entry.data.length;
  }

  const centralStart = cursor;
  for (const entry of prepared) {
    writeUint32(view, cursor, 0x02014b50);
    writeUint16(view, cursor + 4, 20);
    writeUint16(view, cursor + 6, 20);
    writeUint16(view, cursor + 8, 0);
    writeUint16(view, cursor + 10, 0);
    writeUint16(view, cursor + 12, 0);
    writeUint16(view, cursor + 14, 0);
    writeUint32(view, cursor + 16, entry.crc);
    writeUint32(view, cursor + 20, entry.data.length);
    writeUint32(view, cursor + 24, entry.data.length);
    writeUint16(view, cursor + 28, entry.nameBytes.length);
    writeUint16(view, cursor + 30, 0);
    writeUint16(view, cursor + 32, 0);
    writeUint16(view, cursor + 34, 0);
    writeUint16(view, cursor + 36, 0);
    writeUint32(view, cursor + 38, 0);
    writeUint32(view, cursor + 42, entry.localHeaderOffset);
    buffer.set(entry.nameBytes, cursor + CENTRAL_HEADER_SIZE);
    cursor += CENTRAL_HEADER_SIZE + entry.nameBytes.length;
  }

  writeUint32(view, cursor, 0x06054b50);
  writeUint16(view, cursor + 4, 0);
  writeUint16(view, cursor + 6, 0);
  writeUint16(view, cursor + 8, prepared.length);
  writeUint16(view, cursor + 10, prepared.length);
  writeUint32(view, cursor + 12, centralSectionSize);
  writeUint32(view, cursor + 16, centralStart);
  writeUint16(view, cursor + 20, 0);

  return buffer;
}

/** A ZIP32 writer that retains only central-directory metadata, not image data. */
export class StreamingStoredZipWriter {
  private offset = 0;
  private readonly entries: Array<{
    nameBytes: Uint8Array;
    size: number;
    crc: number;
    localHeaderOffset: number;
  }> = [];
  private finalized = false;

  constructor(private readonly writable: Pick<FileSystemWritableFileStream, "write">) {}

  async add(name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.finalized) throw new Error("ZIP archive is already finalized");
    if (!name || !(data instanceof Uint8Array)) throw new Error("ZIP entries require a name and byte data");
    const nameBytes = encodeName(name);
    if (this.entries.length >= 0xffff || nameBytes.length > 0xffff || data.length > 0xffffffff) {
      throw new Error("PNG sequence exceeds ZIP's size or frame-count limit. Export a shorter range.");
    }
    const nextOffset = this.offset + 30 + nameBytes.length + data.length;
    if (nextOffset > 0xffffffff) {
      throw new Error("PNG sequence exceeds ZIP's 4 GB limit. Export a shorter range.");
    }
    const crc = crc32(data);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    writeUint32(view, 0, 0x04034b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0x0800); // UTF-8 filenames
    writeUint32(view, 14, crc);
    writeUint32(view, 18, data.length);
    writeUint32(view, 22, data.length);
    writeUint16(view, 26, nameBytes.length);
    header.set(nameBytes, 30);
    await this.writable.write(header);
    await this.writable.write(data);
    this.entries.push({ nameBytes, size: data.length, crc, localHeaderOffset: this.offset });
    this.offset = nextOffset;
  }

  async finalize(): Promise<void> {
    if (this.finalized) throw new Error("ZIP archive is already finalized");
    this.finalized = true;
    const centralStart = this.offset;
    const centralSize = this.entries.reduce((total, entry) => total + 46 + entry.nameBytes.length, 0);
    if (centralStart + centralSize + 22 > 0xffffffff) {
      throw new Error("PNG sequence exceeds ZIP's 4 GB limit. Export a shorter range.");
    }
    const central = new Uint8Array(centralSize + 22);
    const view = new DataView(central.buffer);
    let cursor = 0;
    for (const entry of this.entries) {
      writeUint32(view, cursor, 0x02014b50);
      writeUint16(view, cursor + 4, 20);
      writeUint16(view, cursor + 6, 20);
      writeUint16(view, cursor + 8, 0x0800);
      writeUint32(view, cursor + 16, entry.crc);
      writeUint32(view, cursor + 20, entry.size);
      writeUint32(view, cursor + 24, entry.size);
      writeUint16(view, cursor + 28, entry.nameBytes.length);
      writeUint32(view, cursor + 42, entry.localHeaderOffset);
      central.set(entry.nameBytes, cursor + 46);
      cursor += 46 + entry.nameBytes.length;
    }
    writeUint32(view, cursor, 0x06054b50);
    writeUint16(view, cursor + 8, this.entries.length);
    writeUint16(view, cursor + 10, this.entries.length);
    writeUint32(view, cursor + 12, centralSize);
    writeUint32(view, cursor + 16, centralStart);
    await this.writable.write(central);
  }
}
