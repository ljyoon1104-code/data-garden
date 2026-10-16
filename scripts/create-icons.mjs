import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const crc = (bytes) => {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let k = 0; k < 8; k++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
};
function chunk(name, data) {
  const tag = Buffer.from(name),
    len = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, sum]);
}
// Rasterise the app's simple leaf/chart mark; no remote image or runtime dependency.
for (const size of [192, 512]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const a = x / size,
        b = y / size,
        u = (a - 0.57) * 0.8 + (b - 0.38) * 0.6,
        v = -(a - 0.57) * 0.6 + (b - 0.38) * 0.8;
      const leaf = (u * u) / 0.028 + (v * v) / 0.009 < 1;
      const bar =
        (a > 0.28 && a < 0.37 && b > 0.53 && b < 0.73) ||
        (a > 0.43 && a < 0.52 && b > 0.46 && b < 0.73) ||
        (a > 0.58 && a < 0.67 && b > 0.56 && b < 0.73);
      const color = leaf || bar ? [233, 243, 219, 255] : [23, 103, 91, 255],
        i = y * (size * 4 + 1) + 1 + x * 4;
      data.set(color, i);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  writeFileSync(
    `public/icon-${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(data)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
