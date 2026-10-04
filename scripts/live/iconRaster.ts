import type { GlyphShape, IconDefinition } from '../iconCatalog.ts';

/**
 * Anti-aliased rasteriser for launcher icons.
 *
 * Shapes are drawn with hard point-in-shape tests at a supersampled resolution
 * and then box-filtered down, which is what produces smooth edges without
 * pulling in a rasteriser dependency. Everything is pure arithmetic on a fixed
 * grid, so the same definition always yields byte-identical output.
 */

const SS = 4; // supersampling factor per axis

export type IconVariant = 'legacy' | 'round' | 'foreground';

export interface Rgba { r: number; g: number; b: number; a: number }

export function hexToRgba(hex: string, alpha = 1): Rgba {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: Math.round(alpha * 255)
  };
}

function pointInRoundRect(x: number, y: number, rx: number, ry: number, rw: number, rh: number, r: number): boolean {
  if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + rw - r);
  const cy = Math.min(Math.max(y, ry + r), ry + rh - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function pointInPolygon(x: number, y: number, pts: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    const intersects = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** A glyph shape resolved into canvas pixels, with its fill colour fixed. */
interface PixelShape {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  fill: Rgba;
  hit(x: number, y: number): boolean;
}

/**
 * Resolves a glyph into canvas-pixel space once per render.
 *
 * Doing this per supersample point dominated the cost of generating an icon
 * (and allocated a new point array for every polygon sample). The arithmetic is
 * identical, so output stays byte-identical - it is only computed once.
 */
function resolveGlyph(def: IconDefinition, glyphBox: number, glyphOrigin: number, fallback: Rgba): PixelShape[] {
  const px = (n: number) => n * glyphBox + glyphOrigin;
  const shapes: PixelShape[] = [];
  for (const shape of def.glyph) {
    const fill = shape.fill ? hexToRgba(shape.fill) : fallback;
    switch (shape.kind) {
      case 'circle': {
        const cx = px(shape.cx || 0);
        const cy = px(shape.cy || 0);
        const rad = (shape.r || 0) * glyphBox;
        const r2 = rad * rad;
        shapes.push({
          minX: cx - rad, maxX: cx + rad, minY: cy - rad, maxY: cy + rad, fill,
          hit: (x, y) => { const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r2; }
        });
        break;
      }
      case 'ring': {
        const cx = px(shape.cx || 0);
        const cy = px(shape.cy || 0);
        const outer = (shape.r || 0) * glyphBox;
        const inner = outer - (shape.thickness || 0) * glyphBox;
        const o2 = outer * outer;
        const i2 = inner * inner;
        shapes.push({
          minX: cx - outer, maxX: cx + outer, minY: cy - outer, maxY: cy + outer, fill,
          hit: (x, y) => { const dx = x - cx, dy = y - cy; const d2 = dx * dx + dy * dy; return d2 <= o2 && d2 >= i2; }
        });
        break;
      }
      case 'roundRect': {
        const x = px(shape.x || 0);
        const y = px(shape.y || 0);
        const w = (shape.w || 0) * glyphBox;
        const h = (shape.h || 0) * glyphBox;
        const rad = (shape.radius || 0) * glyphBox;
        shapes.push({
          minX: x, maxX: x + w, minY: y, maxY: y + h, fill,
          hit: (px2, py2) => pointInRoundRect(px2, py2, x, y, w, h, rad)
        });
        break;
      }
      case 'capsule': {
        const x1 = px(shape.x1 || 0);
        const y1 = px(shape.y1 || 0);
        const x2 = px(shape.x2 || 0);
        const y2 = px(shape.y2 || 0);
        const half = ((shape.stroke || 0.1) / 2) * glyphBox;
        shapes.push({
          minX: Math.min(x1, x2) - half, maxX: Math.max(x1, x2) + half,
          minY: Math.min(y1, y2) - half, maxY: Math.max(y1, y2) + half, fill,
          hit: (x, y) => distanceToSegment(x, y, x1, y1, x2, y2) <= half
        });
        break;
      }
      case 'polygon': {
        const pts = (shape.points || []).map(([x, y]) => [px(x), px(y)] as [number, number]);
        if (pts.length < 3) break;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of pts) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        shapes.push({ minX, maxX, minY, maxY, fill, hit: (x, y) => pointInPolygon(x, y, pts) });
        break;
      }
    }
  }
  return shapes;
}

/**
 * Rendered icons are pure functions of (definition, size, variant), and a single
 * process generates the same few icon sets repeatedly (the whole test suite does).
 * A small bounded cache keeps that work from being redone; it changes nothing
 * about the bytes produced.
 */
const renderCache = new Map<string, Buffer>();
const RENDER_CACHE_LIMIT = 96;

function renderKey(def: IconDefinition, size: number, variant: IconVariant): string {
  return `${variant}|${size}|${def.category}|${def.palette.from}|${def.palette.to}|${def.palette.fg}|${JSON.stringify(def.glyph)}`;
}

/**
 * Renders one icon to RGBA pixels.
 *
 * `legacy` is a rounded square, `round` is a circle, and `foreground` is the
 * adaptive-icon layer: glyph only, on transparency, sized inside the 72/108dp
 * safe zone so no launcher mask can clip it.
 */
export function renderIcon(def: IconDefinition, size: number, variant: IconVariant): Buffer {
  const key = renderKey(def, size, variant);
  const cached = renderCache.get(key);
  if (cached) return Buffer.from(cached);

  const hi = size * SS;
  const acc = new Float64Array(size * size * 4);
  const fg = hexToRgba(def.palette.fg);
  const from = hexToRgba(def.palette.from);
  const to = hexToRgba(def.palette.to);

  // Glyph occupies the inner share of the canvas, centred. The adaptive
  // foreground follows the platform guidance that the glyph lives inside the
  // 72/108dp safe zone (0.6 leaves margin for every launcher mask), while a
  // legacy icon is drawn slightly larger because it has no mask to survive.
  const glyphShare = variant === 'foreground' ? 0.6 : 0.58;
  const glyphBox = hi * glyphShare;
  const glyphOrigin = (hi - glyphBox) / 2;
  const shapes = resolveGlyph(def, glyphBox, glyphOrigin, fg);

  const cornerRadius = hi * 0.2237; // ~22% reads as a modern launcher squircle

  for (let sy = 0; sy < hi; sy++) {
    const py = sy + 0.5;
    // The background gradient only varies by row.
    const t = py / hi;
    const br = from.r + (to.r - from.r) * t;
    const bg = from.g + (to.g - from.g) * t;
    const bb = from.b + (to.b - from.b) * t;

    for (let sx = 0; sx < hi; sx++) {
      const px = sx + 0.5;

      // Background.
      let r = 0, g = 0, b = 0, a = 0;
      if (variant === 'legacy') {
        if (pointInRoundRect(px, py, 0, 0, hi, hi, cornerRadius)) {
          r = br; g = bg; b = bb; a = 255;
        }
      } else if (variant === 'round') {
        const dx = px - hi / 2;
        const dy = py - hi / 2;
        if (dx * dx + dy * dy <= (hi / 2) * (hi / 2)) {
          r = br; g = bg; b = bb; a = 255;
        }
      }

      // Glyph. Shapes are tested in order so a later shape paints over an
      // earlier one, exactly as when they were drawn directly.
      for (let s = 0; s < shapes.length; s++) {
        const shape = shapes[s];
        if (px < shape.minX || px > shape.maxX || py < shape.minY || py > shape.maxY) continue;
        if (!shape.hit(px, py)) continue;
        r = shape.fill.r; g = shape.fill.g; b = shape.fill.b; a = 255;
      }

      const dx = Math.floor(sx / SS);
      const dy = Math.floor(sy / SS);
      const di = (dy * size + dx) * 4;
      acc[di] += r;
      acc[di + 1] += g;
      acc[di + 2] += b;
      acc[di + 3] += a;
    }
  }

  const samples = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = Math.round(acc[i * 4] / samples);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / samples);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / samples);
    out[i * 4 + 3] = Math.round(acc[i * 4 + 3] / samples);
  }

  if (renderCache.size >= RENDER_CACHE_LIMIT) renderCache.clear();
  renderCache.set(key, Buffer.from(out));
  return out;
}

export interface IconStatistics {
  /** Distinct quantised colours; a flat placeholder has very few. */
  distinctColours: number;
  /** Fraction of pixels that are not fully transparent. */
  opaqueFraction: number;
  /** Fraction of opaque pixels far from the dominant colour (the glyph). */
  contrastFraction: number;
  dominant: Rgba;
}

/** Structural statistics used to tell a real icon from a flat placeholder. */
export function iconStatistics(rgba: Buffer, width: number, height: number): IconStatistics {
  const buckets = new Map<number, number>();
  const opaque = new Map<number, number>();
  let opaqueCount = 0;
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 16) continue;
    opaqueCount++;
    const key = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
    opaque.set(key, (opaque.get(key) || 0) + 1);
  }
  let dominantKey = 0;
  let dominantCount = 0;
  for (const [key, count] of buckets) {
    if (count > dominantCount) { dominantCount = count; dominantKey = key; }
  }
  const total = width * height;
  let contrast = 0;
  if (opaqueCount > 0) {
    for (let i = 0; i < width * height; i++) {
      if (rgba[i * 4 + 3] < 16) continue;
      const key = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
      if (key !== dominantKey) contrast++;
    }
  }
  // Recover an approximate representative colour for the dominant bucket.
  let dr = 0, dg = 0, db = 0, dn = 0;
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] < 16) continue;
    const key = ((rgba[i * 4] >> 4) << 8) | ((rgba[i * 4 + 1] >> 4) << 4) | (rgba[i * 4 + 2] >> 4);
    if (key === dominantKey) { dr += rgba[i * 4]; dg += rgba[i * 4 + 1]; db += rgba[i * 4 + 2]; dn++; }
  }
  return {
    distinctColours: buckets.size,
    opaqueFraction: opaqueCount / total,
    contrastFraction: opaqueCount ? contrast / opaqueCount : 0,
    dominant: dn ? { r: Math.round(dr / dn), g: Math.round(dg / dn), b: Math.round(db / dn), a: 255 } : { r: 0, g: 0, b: 0, a: 0 }
  };
}

/**
 * Fixed-size RGBA grid used to compare two renderings of the same icon.
 * Averaging over cells makes the comparison tolerant of the colour-depth and
 * palette changes AAPT2 may apply, while still failing on a different picture.
 */
export function iconSignature(rgba: Buffer, width: number, height: number, cells = 16): Buffer {
  const out = Buffer.alloc(cells * cells * 4);
  const cellW = width / cells;
  const cellH = height / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(cx * cellW);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW));
      const y0 = Math.floor(cy * cellH);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const alpha = rgba[i + 3] / 255;
          // Composite over white so transparent regions compare consistently.
          r += rgba[i] * alpha + 255 * (1 - alpha);
          g += rgba[i + 1] * alpha + 255 * (1 - alpha);
          b += rgba[i + 2] * alpha + 255 * (1 - alpha);
          a += rgba[i + 3];
          n++;
        }
      }
      const o = (cy * cells + cx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** Mean absolute per-channel difference between two signatures, 0..255. */
export function signatureDistance(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 255;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}
