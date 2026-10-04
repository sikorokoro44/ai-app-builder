import { deflateSync, inflateSync } from 'zlib';

/**
 * Minimal but standards-correct PNG codec.
 *
 * The launcher icon has to be a real image, not a file that merely claims to be
 * one, so both directions are implemented here: the generator encodes genuine
 * PNGs, and the APK verifier decodes whatever the Android toolchain actually
 * emitted. Encoding and decoding live together on purpose, because a validator
 * that shares the encoder's assumptions cannot catch an encoder that is wrong.
 *
 * Only what an icon needs is supported: bit depth 8, non-interlaced, greyscale /
 * RGB / palette / greyscale+alpha / RGBA. That covers everything AAPT2 emits for
 * a launcher icon, including the palette images it produces when it crunches.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Int32Array | null = null;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** True when every chunk's CRC matched and the stream ended with IEND. */
  structurallyValid: boolean;
  errors: string[];
}

/**
 * Reads the header without decoding pixels. Cheap enough to run over every
 * density of every icon during validation.
 */
export function readPngInfo(buf: Buffer): PngInfo | null {
  const errors: string[] = [];
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { width: 0, height: 0, bitDepth: 0, colorType: 0, structurallyValid: false, errors: ['not a PNG (bad signature)'] };
  }
  let off = 8;
  let info: PngInfo | null = null;
  let sawEnd = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) {
      errors.push(`truncated chunk ${type}`);
      break;
    }
    const declared = buf.readUInt32BE(dataEnd);
    if (crc32(buf.subarray(off + 4, dataEnd)) !== declared) {
      errors.push(`bad CRC in chunk ${type}`);
    }
    if (type === 'IHDR') {
      if (len < 13) { errors.push('IHDR too short'); break; }
      const width = buf.readUInt32BE(dataStart);
      const height = buf.readUInt32BE(dataStart + 4);
      info = {
        width, height,
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        structurallyValid: false,
        errors
      };
      if (buf[dataStart + 10] !== 0) errors.push('unsupported compression method');
      if (buf[dataStart + 12] !== 0) errors.push('interlaced PNG is not supported');
    } else if (type === 'IEND') {
      sawEnd = true;
    }
    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (!info) return { width: 0, height: 0, bitDepth: 0, colorType: 0, structurallyValid: false, errors: ['no IHDR chunk'] };
  if (!sawEnd) errors.push('no IEND chunk');
  info.structurallyValid = errors.length === 0;
  info.errors = errors;
  return info;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Buffer;
}

function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0: return 1;
    case 2: return 3;
    case 3: return 1;
    case 4: return 2;
    case 6: return 4;
    default: return 0;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Fully decodes a PNG to RGBA. Returns null when the file is not a PNG this
 * decoder can read, which is how a malformed or truncated icon is detected.
 */
export function decodePng(buf: Buffer): DecodedImage | null {
  const info = readPngInfo(buf);
  if (!info || info.width === 0 || info.height === 0) return null;
  const { width, height, bitDepth, colorType } = info;
  if (bitDepth !== 8) return null;
  const channels = channelsFor(colorType);
  if (channels === 0) return null;

  let off = 8;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let sawEnd = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) return null;
    if (type === 'IDAT') idat.push(buf.subarray(dataStart, dataEnd));
    else if (type === 'PLTE') palette = Buffer.from(buf.subarray(dataStart, dataEnd));
    else if (type === 'IEND') { sawEnd = true; break; }
    off = dataEnd + 4;
  }
  if (!idat.length || !sawEnd) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;

  const lines = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let value = src[x];
      switch (filter) {
        case 0: break;
        case 1: value = (value + a) & 0xff; break;
        case 2: value = (value + b) & 0xff; break;
        case 3: value = (value + ((a + b) >> 1)) & 0xff; break;
        case 4: value = (value + paeth(a, b, c)) & 0xff; break;
        default: return null;
      }
      dst[x] = value;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const s = i * bpp;
    switch (colorType) {
      case 0:
        rgba[p] = rgba[p + 1] = rgba[p + 2] = lines[s];
        rgba[p + 3] = 255;
        break;
      case 2:
        rgba[p] = lines[s]; rgba[p + 1] = lines[s + 1]; rgba[p + 2] = lines[s + 2]; rgba[p + 3] = 255;
        break;
      case 3: {
        if (!palette) return null;
        const idx = lines[s] * 3;
        if (idx + 2 >= palette.length) return null;
        rgba[p] = palette[idx]; rgba[p + 1] = palette[idx + 1]; rgba[p + 2] = palette[idx + 2]; rgba[p + 3] = 255;
        break;
      }
      case 4:
        rgba[p] = rgba[p + 1] = rgba[p + 2] = lines[s];
        rgba[p + 3] = lines[s + 1];
        break;
      case 6:
        rgba[p] = lines[s]; rgba[p + 1] = lines[s + 1]; rgba[p + 2] = lines[s + 2]; rgba[p + 3] = lines[s + 3];
        break;
      default:
        return null;
    }
  }
  return { width, height, rgba };
}

/** Encodes 8-bit RGBA pixels as a non-interlaced truecolour-with-alpha PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`pixel buffer is ${rgba.length} bytes, expected ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
