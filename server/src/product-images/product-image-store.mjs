import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function isPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  let chunkCount = 0;
  let hasHeader = false;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const checksum = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== checksum) return false;
    if (chunkCount === 0 && (type !== 'IHDR' || length !== 13)) return false;
    if (type === 'IHDR') hasHeader = true;
    if (type === 'IDAT') hasImageData = true;
    offset = end;
    chunkCount += 1;
    if (type === 'IEND') return length === 0 && hasHeader && hasImageData && offset === bytes.length;
  }
  return false;
}

function isJpeg(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return hasFrame && hasScan && offset === bytes.length;
    if (marker === 0xd8 || marker === 0x00 || marker >= 0xd0 && marker <= 0xd7) return false;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8) return false;
      hasFrame = true;
    }
    offset += segmentLength;
    if (marker === 0xda) {
      if (!hasFrame || segmentLength < 6) return false;
      hasScan = true;
      let foundMarker = false;
      while (offset < bytes.length - 1) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const next = bytes[offset + 1];
        if (next === 0x00 || next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
        foundMarker = true;
        break;
      }
      if (!foundMarker) return false;
    }
  }
  return false;
}

function isWebp(bytes) {
  if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  let chunkCount = 0;
  let extended = false;
  let hasAlpha = false;
  let imageType = null;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    const chunkEnd = dataEnd + (chunkSize & 1);
    if (dataEnd > bytes.length || chunkEnd > bytes.length) return false;

    if (chunkCount === 0) {
      if (chunkType === 'VP8X') {
        if (chunkSize !== 10) return false;
        extended = true;
      } else if (chunkType !== 'VP8 ' && chunkType !== 'VP8L') return false;
    } else if (!extended) return false;

    if (chunkType === 'VP8X' && chunkCount !== 0) return false;
    if (chunkType === 'ALPH') {
      if (!extended || hasAlpha || imageType !== null) return false;
      hasAlpha = true;
    } else if (chunkType === 'VP8 ' || chunkType === 'VP8L') {
      if (imageType !== null) return false;
      if (chunkType === 'VP8 ') {
        if (chunkSize < 10 || bytes[dataStart + 3] !== 0x9d
          || bytes[dataStart + 4] !== 0x01 || bytes[dataStart + 5] !== 0x2a) return false;
      } else if (chunkSize < 5 || bytes[dataStart] !== 0x2f || hasAlpha) return false;
      imageType = chunkType;
    } else if (!['VP8X', 'ICCP', 'EXIF', 'XMP ', 'ALPH'].includes(chunkType)) return false;

    offset = chunkEnd;
    chunkCount += 1;
    if (offset === bytes.length) {
      return imageType !== null && (extended || chunkCount === 1);
    }
  }
  return false;
}

const FORMATS = new Map([
  ['image/png', { extension: 'png', matches: isPng }],
  ['image/jpeg', { extension: 'jpg', matches: isJpeg }],
  ['image/webp', { extension: 'webp', matches: isWebp }],
]);

export class ProductImageError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ProductImageError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function readProductImageRequest(request) {
  const declaredLength = Number(request.headers['content-length']);
  const declaredTooLarge = Number.isFinite(declaredLength) && declaredLength > MAX_PRODUCT_IMAGE_BYTES;
  const chunks = [];
  let size = 0;
  let tooLarge = declaredTooLarge;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PRODUCT_IMAGE_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new ProductImageError(413, 'IMAGE_TOO_LARGE', '画像は5MB以下を選択してください。');
  if (size === 0) throw new ProductImageError(400, 'IMAGE_EMPTY', '画像データが空です。');
  const bytes = Buffer.concat(chunks, size);
  const format = FORMATS.get(String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase());
  if (!format) throw new ProductImageError(415, 'IMAGE_TYPE_UNSUPPORTED', 'PNG・JPEG・WebP形式のみアップロードできます。');
  if (!format.matches(bytes)) throw new ProductImageError(400, 'IMAGE_DATA_INVALID', '選択した形式と画像データが一致しません。画像ファイルを確認してください。');
  return { bytes, format };
}

export function createProductImageStore({ root }) {
  if (typeof root !== 'string' || !root.trim()) throw new TypeError('An absolute product image storage path is required.');
  return Object.freeze({
    root,
    async save(bytes, format) {
      await mkdir(root, { recursive: true });
      const filename = `${randomUUID()}.${format.extension}`;
      const path = join(root, filename);
      const handle = await open(path, 'wx', 0o640);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { filename, uri: `/v1/product-images/${filename}` };
    },
    async read(filename) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/.test(filename)) return null;
      const format = [...FORMATS.entries()].find(([, item]) => item.extension === filename.split('.').pop());
      if (!format) return null;
      try { return { bytes: await readFile(join(root, filename)), contentType: format[0] }; }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    },
  });
}
