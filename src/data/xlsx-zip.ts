import { Inflate } from "pako";

const MiB = 1024 * 1024;

export const xlsxZipLimits = {
  fileBytes: 20 * MiB,
  entries: 1024,
  declaredEntryBytes: 64 * MiB,
  declaredBytes: 128 * MiB,
  actualBytes: 48 * MiB,
};

const signatures = {
  end: 0x06054b50,
  directory: 0x02014b50,
  local: 0x04034b50,
  descriptor: 0x08074b50,
};

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++)
    n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function invalidZip(): never {
  throw new Error(
    "유효한 XLSX ZIP 구조가 아닙니다. 암호·분할 압축·ZIP64를 사용하지 않는 XLSX로 다시 저장하세요.",
  );
}

function sizeLimit(): never {
  throw new Error("XLSX 압축 해제 한도를 넘었습니다. 시트나 파일을 나누어 다시 열어 주세요.");
}

function assertZip(condition: unknown): asserts condition {
  if (!condition) invalidZip();
}

export function partSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment).normalize("NFC");
    assertZip(decoded && !/[/\\%:#?\x00-\x1f\x7f]/.test(decoded));
    return decoded;
  } catch {
    return invalidZip();
  }
}

function entryKey(name: string): string {
  const segments = name.replace(/\/$/, "").split("/").map(partSegment);
  assertZip(segments.every((part) => part !== "." && part !== ".."));
  return segments.join("/").toLowerCase();
}

interface ZipEntry {
  offset: number;
  compressed: number;
  size: number;
  method: number;
  crc: number;
}

export interface XlsxArchive {
  read(name: string, maximum: number): Promise<Uint8Array<ArrayBuffer>>;
}

export function openXlsxArchive(buffer: ArrayBuffer): XlsxArchive {
  if (buffer.byteLength > xlsxZipLimits.fileBytes) sizeLimit();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const lowerEnd = Math.max(0, bytes.length - 22 - 0xffff);
  let end = bytes.length - 22;
  while (end >= lowerEnd && !(u32(end) === signatures.end && end + 22 + u16(end + 20) === bytes.length))
    end--;
  assertZip(end >= lowerEnd);
  const count = u16(end + 10);
  const directory = u32(end + 16);
  assertZip(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count);
  assertZip(count > 0 && count !== 0xffff && directory + u32(end + 12) === end);
  if (count > xlsxZipLimits.entries) sizeLimit();

  const entries = new Map<string, ZipEntry>();
  const paths = new Set<string>();
  const intervals: Array<{ start: number; end: number }> = [];
  let cursor = directory;
  let declared = 0;

  function extras(start: number, stop: number) {
    while (start < stop) {
      assertZip(start + 4 <= stop && u16(start) !== 1);
      start += 4 + u16(start + 2);
    }
    assertZip(start === stop);
  }

  for (let i = 0; i < count; i++) {
    assertZip(cursor + 46 <= end && u32(cursor) === signatures.directory);
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const crc = u32(cursor + 16);
    const compressed = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameSize = u16(cursor + 28);
    const extraSize = u16(cursor + 30);
    const commentSize = u16(cursor + 32);
    const local = u32(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameSize;
    const extraEnd = nameEnd + extraSize;
    const next = extraEnd + commentSize;
    assertZip(next <= end && nameSize > 0 && nameSize <= 1024 && u16(cursor + 34) === 0);
    // UTF-8, data descriptor and DEFLATE compression-level hint bits only.
    assertZip((flags & ~0x080e) === 0 && (method === 0 || method === 8));
    assertZip(size !== 0xffffffff && compressed !== 0xffffffff);
    assertZip(method !== 0 || compressed === size);
    if (size > xlsxZipLimits.declaredEntryBytes || (declared += size) > xlsxZipLimits.declaredBytes)
      sizeLimit();
    extras(nameEnd, extraEnd);

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    } catch {
      return invalidZip();
    }
    const key = entryKey(name);
    assertZip(!paths.has(key));
    paths.add(key);

    assertZip(local + 30 <= directory && u32(local) === signatures.local);
    assertZip(u16(local + 6) === flags && u16(local + 8) === method && u16(local + 26) === nameSize);
    const localNameEnd = local + 30 + nameSize;
    const offset = localNameEnd + u16(local + 28);
    let stop = offset + compressed;
    assertZip(stop <= directory);
    const localName = bytes.subarray(local + 30, localNameEnd);
    assertZip(localName.every((value, j) => value === bytes[nameStart + j]));
    extras(localNameEnd, offset);

    const valuesMatch = (at: number) =>
      u32(at) === crc && u32(at + 4) === compressed && u32(at + 8) === size;
    if (flags & 8) {
      assertZip(valuesMatch(local + 14) || (u32(local + 14) === 0 && u32(local + 18) === 0 && u32(local + 22) === 0));
      if (stop + 16 <= directory && u32(stop) === signatures.descriptor && valuesMatch(stop + 4))
        stop += 16;
      else {
        assertZip(stop + 12 <= directory && valuesMatch(stop));
        stop += 12;
      }
    } else assertZip(valuesMatch(local + 14));
    intervals.push({ start: local, end: stop });
    if (!name.endsWith("/")) entries.set(key, { offset, compressed, size, method, crc });
    else assertZip(size === 0);
    cursor = next;
  }
  assertZip(cursor === end);
  let occupied = 0;
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    assertZip(interval.start === occupied);
    occupied = interval.end;
  }
  assertZip(occupied === directory);

  let actual = 0;
  return {
    async read(name, maximum) {
      const entry = entries.get(name.toLowerCase());
      assertZip(entry);
      if (entry.size > maximum || entry.size + actual > xlsxZipLimits.actualBytes) sizeLimit();
      const source = bytes.subarray(entry.offset, entry.offset + entry.compressed);
      const out = entry.method === 0 ? source : new Uint8Array(entry.size);
      let written = 0;
      let crc = 0xffffffff;
      const consume = (chunk: Uint8Array) => {
        if (written + chunk.length > entry.size || written + chunk.length > maximum ||
          actual + chunk.length > xlsxZipLimits.actualBytes) sizeLimit();
        if (entry.method === 8) out.set(chunk, written);
        for (const value of chunk) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
        written += chunk.length;
        actual += chunk.length;
      };
      if (entry.method === 0) consume(source);
      else {
        // pako calls onData for each fixed-size output buffer. Throwing there
        // stops expansion before a complete forged entry can be materialized.
        // These stream counters are present in the pinned pako implementation,
        // but omitted by @types/pako. They also detect trailing compressed bytes.
        const inflater = new Inflate({ raw: true, chunkSize: 16 * 1024 }) as Inflate & {
          ended: boolean;
          strm: { total_in: number };
        };
        inflater.onData = consume;
        for (let position = 0; position < source.length; position += 1024) {
          const stop = Math.min(source.length, position + 1024);
          if (!inflater.push(source.subarray(position, stop), stop === source.length)) invalidZip();
          if (inflater.ended && stop !== source.length) invalidZip();
        }
        if (!inflater.ended || inflater.err || inflater.strm.total_in !== source.length) invalidZip();
      }
      assertZip(written === entry.size && ((crc ^ 0xffffffff) >>> 0) === entry.crc);
      return out;
    },
  };
}
