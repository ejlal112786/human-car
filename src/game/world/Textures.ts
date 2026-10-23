import { CanvasTexture, RepeatWrapping, SRGBColorSpace, NoColorSpace, type Texture } from 'three';
import { mulberry32 } from './random';

/**
 * Procedurally generated canvas textures, so the game ships with no binary assets
 * and never depends on external URLs.
 */

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available for texture generation.');
  return [c, ctx];
}

function toTexture(canvas: HTMLCanvasElement, color: boolean, anisotropy: number): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.colorSpace = color ? SRGBColorSpace : NoColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** Fill with per-pixel noise around a base grey/colour. */
function noise(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, seed: number): void {
  const rnd = mulberry32(seed);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const n = (rnd() - 0.5) * amp + (rnd() - 0.5) * amp * 0.5;
    d[i * 4] = base[0] + n;
    d[i * 4 + 1] = base[1] + n;
    d[i * 4 + 2] = base[2] + n;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export interface TextureSet {
  asphalt: Texture;
  asphaltRough: Texture;
  sidewalk: Texture;
  curb: Texture;
  grass: Texture;
  checker: Texture;
  facades: Array<{ map: Texture; rough: Texture; tileW: number; tileH: number }>;
  dispose(): void;
}

function asphalt(aniso: number): [Texture, Texture] {
  const S = 512;
  const [c, ctx] = makeCanvas(S, S);
  noise(ctx, S, S, [58, 59, 62], 34, 11);
  const rnd = mulberry32(5);
  // darker patches and repairs
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(20,20,22,${0.05 + rnd() * 0.1})`;
    ctx.beginPath();
    ctx.ellipse(rnd() * S, rnd() * S, 10 + rnd() * 60, 6 + rnd() * 40, rnd() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // fine cracks
  ctx.strokeStyle = 'rgba(15,15,15,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    let x = rnd() * S;
    let y = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (rnd() - 0.5) * 30;
      y += (rnd() - 0.5) * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // tyre wear lines (lighter, along V)
  for (let i = 0; i < 4; i++) {
    const x = (i + 0.5) * (S / 4) + (rnd() - 0.5) * 20;
    const g = ctx.createLinearGradient(x - 18, 0, x + 18, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(25,25,28,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 18, 0, 36, S);
  }
  const [rc, rctx] = makeCanvas(256, 256);
  noise(rctx, 256, 256, [215, 215, 215], 50, 17);
  return [toTexture(c, true, aniso), toTexture(rc, false, aniso)];
}

function sidewalk(aniso: number): Texture {
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  noise(ctx, S, S, [168, 166, 160], 22, 23);
  const rnd = mulberry32(3);
  const n = 4;
  const cell = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = (rnd() - 0.5) * 18;
      ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  ctx.strokeStyle = 'rgba(70,68,64,0.6)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, S);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(S, i * cell);
    ctx.stroke();
  }
  return toTexture(c, true, aniso);
}

function curb(aniso: number): Texture {
  const [c, ctx] = makeCanvas(16, 64);
  ctx.fillStyle = '#b8231c';
  ctx.fillRect(0, 0, 16, 32);
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(0, 32, 16, 32);
  return toTexture(c, true, aniso);
}

function grass(aniso: number): Texture {
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  const rnd = mulberry32(31);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = rnd();
    img.data[i * 4] = 62 + n * 30;
    img.data[i * 4 + 1] = 92 + n * 40;
    img.data[i * 4 + 2] = 44 + n * 18;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${rnd() > 0.5 ? '90,80,50' : '40,70,30'},${0.08 + rnd() * 0.1})`;
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, 8 + rnd() * 30, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, true, aniso);
}

function checker(aniso: number): Texture {
  const [c, ctx] = makeCanvas(128, 32);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee';
      ctx.fillRect(x * 16, y * 16, 16, 16);
    }
  return toTexture(c, true, aniso);
}

interface FacadeStyle {
  wall: string;
  glass: [string, string];
  frame: string;
  /** Window rectangle inside a bay as fractions [x0, y0, x1, y1]. */
  win: [number, number, number, number];
  bays: [number, number];
  tileW: number;
  tileH: number;
  wallRough: number;
}

const FACADE_STYLES: FacadeStyle[] = [
  // warm concrete office
  { wall: '#bfb4a2', glass: ['#2c3a48', '#56697a'], frame: '#6f6a62', win: [0.14, 0.18, 0.86, 0.82], bays: [4, 4], tileW: 14, tileH: 14, wallRough: 0.9 },
  // blue glass curtain wall
  { wall: '#5b6670', glass: ['#3a5f80', '#86a7c2'], frame: '#2c3238', win: [0.04, 0.04, 0.96, 0.9], bays: [4, 4], tileW: 12, tileH: 14, wallRough: 0.5 },
  // red brick residential
  { wall: '#8a4a36', glass: ['#28313a', '#4e5d69'], frame: '#e8e2d6', win: [0.25, 0.2, 0.75, 0.78], bays: [4, 4], tileW: 13, tileH: 12.8, wallRough: 0.95 },
  // grey modern with ribbon windows
  { wall: '#d7d8d6', glass: ['#1f2a33', '#4a5b68'], frame: '#9fa3a5', win: [0.0, 0.3, 1.0, 0.78], bays: [4, 4], tileW: 16, tileH: 14, wallRough: 0.8 },
  // dark tower
  { wall: '#2f3236', glass: ['#26384a', '#6b8aa6'], frame: '#1b1d20', win: [0.08, 0.08, 0.92, 0.92], bays: [4, 4], tileW: 12, tileH: 13.6, wallRough: 0.6 },
];

function facade(style: FacadeStyle, seed: number, aniso: number): { map: Texture; rough: Texture; tileW: number; tileH: number } {
  const S = 512;
  const [c, ctx] = makeCanvas(S, S);
  const [rc, rctx] = makeCanvas(S, S);
  const rnd = mulberry32(seed);
  ctx.fillStyle = style.wall;
  ctx.fillRect(0, 0, S, S);
  // subtle wall noise
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const n = (rnd() - 0.5) * 14;
    img.data[i * 4] += n;
    img.data[i * 4 + 1] += n;
    img.data[i * 4 + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const wr = Math.round(style.wallRough * 255);
  rctx.fillStyle = `rgb(${wr},${wr},${wr})`;
  rctx.fillRect(0, 0, S, S);

  const [bx, by] = style.bays;
  const cw = S / bx;
  const ch = S / by;
  const [x0, y0, x1, y1] = style.win;
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      const wx = i * cw + x0 * cw;
      const wy = j * ch + y0 * ch;
      const ww = (x1 - x0) * cw;
      const wh = (y1 - y0) * ch;
      // frame
      ctx.fillStyle = style.frame;
      ctx.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
      // glass with sky-reflection gradient and per-window variation
      const g = ctx.createLinearGradient(wx, wy, wx + ww * 0.3, wy + wh);
      const shade = rnd();
      g.addColorStop(0, shade > 0.85 ? '#a9bccb' : style.glass[1]);
      g.addColorStop(1, style.glass[0]);
      ctx.fillStyle = g;
      ctx.fillRect(wx, wy, ww, wh);
      // occasional blinds
      if (rnd() > 0.7) {
        ctx.fillStyle = 'rgba(220,214,196,0.55)';
        ctx.fillRect(wx, wy, ww, wh * (0.2 + rnd() * 0.5));
      }
      // mullion
      ctx.fillStyle = style.frame;
      if (ww > cw * 0.6) ctx.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      rctx.fillStyle = 'rgb(35,35,35)';
      rctx.fillRect(wx, wy, ww, wh);
    }
    // floor slab line
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, (j + 1) * ch - 4, S, 4);
  }
  return { map: toTexture(c, true, aniso), rough: toTexture(rc, false, aniso), tileW: style.tileW, tileH: style.tileH };
}

export function createTextures(anisotropy: number): TextureSet {
  const [asphaltMap, asphaltRough] = asphalt(anisotropy);
  const set: TextureSet = {
    asphalt: asphaltMap,
    asphaltRough,
    sidewalk: sidewalk(anisotropy),
    curb: curb(anisotropy),
    grass: grass(anisotropy),
    checker: checker(anisotropy),
    facades: FACADE_STYLES.map((s, i) => facade(s, 100 + i * 7, anisotropy)),
    dispose() {
      const all: Texture[] = [set.asphalt, set.asphaltRough, set.sidewalk, set.curb, set.grass, set.checker];
      for (const f of set.facades) all.push(f.map, f.rough);
      for (const t of all) t.dispose();
    },
  };
  return set;
}
