function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], r: () => number) {
  return arr[Math.floor(r() * arr.length)]!;
}

export function generateFallbackPosterSvg({
  width,
  height,
  seed,
  reservedTopRatio = 0.22
}: {
  width: number;
  height: number;
  seed: number;
  reservedTopRatio?: number;
}) {
  const r = mulberry32(seed);
  const palettes = [
    ["#0ea5e9", "#a78bfa", "#22c55e", "#f97316", "#e11d48"],
    ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a3a3a3"],
    ["#06b6d4", "#f43f5e", "#8b5cf6", "#10b981", "#f59e0b"]
  ];
  const p = pick(palettes, r);
  const bg1 = pick(p, r);
  const bg2 = pick(p, r);
  const reservedH = Math.floor(height * reservedTopRatio);

  const blobs = Array.from({ length: 10 }).map((_, i) => {
    const cx = Math.floor(r() * width);
    const cy = Math.floor(reservedH + r() * (height - reservedH));
    const rx = Math.floor(width * (0.15 + r() * 0.35));
    const ry = Math.floor(height * (0.08 + r() * 0.2));
    const fill = pick(p, r);
    const op = (0.22 + r() * 0.22).toFixed(3);
    const rot = Math.floor(r() * 360);
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" fill-opacity="${op}" transform="rotate(${rot} ${cx} ${cy})" />`;
  });

  const noiseDots = Array.from({ length: 120 }).map(() => {
    const x = Math.floor(r() * width);
    const y = Math.floor(reservedH + r() * (height - reservedH));
    const s = (1 + r() * 3).toFixed(2);
    const op = (0.06 + r() * 0.08).toFixed(3);
    return `<circle cx="${x}" cy="${y}" r="${s}" fill="white" fill-opacity="${op}" />`;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg1}" />
      <stop offset="100%" stop-color="${bg2}" />
    </linearGradient>
    <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="35" />
    </filter>
  </defs>

  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bg)" />

  <!-- Reserved blank area for later text layers -->
  <rect x="0" y="0" width="${width}" height="${reservedH}" fill="#000000" fill-opacity="0.12" />
  <rect x="0" y="0" width="${width}" height="${reservedH}" fill="#ffffff" fill-opacity="0.04" />

  <g filter="url(#blur)">
    ${blobs.join("\n    ")}
  </g>

  <g>
    ${noiseDots.join("\n    ")}
  </g>
</svg>`;

  const prompt = `Abstract poster background, no text, no letters, no watermark, reserved blank space on top (~${Math.round(
    reservedTopRatio * 100
  )}%), vibrant gradient + soft blurred blobs, minimal modern style.`;
  const negativePrompt = "text, letters, words, logo, watermark, typography, caption, subtitle";

  return { svg, prompt, negativePrompt, palette: p };
}

