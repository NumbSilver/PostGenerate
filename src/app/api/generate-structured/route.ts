import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, publicDir, writeJson, dataDir } from "@/lib/storage";
import { nanoBanana3pGenerateImage } from "@/lib/nanobanana-3p";
import { fitTextInBox, TEXT_LINE_HEIGHT } from "@/lib/text-alignment";
import type { PosterImageLayer, PosterProject, PosterTextLayer } from "@/lib/types";
import { PNG } from "pngjs";

export const runtime = "nodejs";

const STRUCTURE_LLM_MODEL = "gpt-5.4-2026-03-05";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BodySchema = z.object({
  script: z.string().min(1),
  assetsText: z.string().optional(),
  styleHint: z.string().optional(),
  readabilityLevel: z.enum(["weak", "medium", "strong"]).optional(),
  size: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096)
  })
});

const LlmPlanSchema = z.object({
  plan: z.string().min(1),
  textBlocks: z.array(
    z.object({
      id: z.string().min(1),
      role: z.enum(["title", "subtitle", "body", "list", "highlight", "note"]),
      text: z.string().min(1),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      fontSize: z.number().optional(),
      fontWeight: z.number().optional(),
      color: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      lineHeight: z.number().optional(),
      letterSpacing: z.number().optional(),
      opacity: z.number().optional(),
      stroke: z.string().optional(),
      strokeWidth: z.number().optional(),
      shadowColor: z.string().optional(),
      shadowBlur: z.number().optional(),
      shadowOffsetX: z.number().optional(),
      shadowOffsetY: z.number().optional(),
      shadowOpacity: z.number().optional(),
      backdrop: z
        .object({
          enabled: z.boolean().optional(),
          fillColor: z.string().optional(),
          borderColor: z.string().optional(),
          borderWidth: z.number().optional(),
          radius: z.number().optional(),
          padding: z.number().optional()
        })
        .optional()
    })
  ),
  palette: z
    .object({
      background: z.string().optional(),
      primary: z.string().optional(),
      secondary: z.string().optional(),
      accent: z.string().optional()
    })
    .optional(),
  fonts: z
    .object({
      title: z.string().optional(),
      body: z.string().optional(),
      display: z.string().optional()
    })
    .optional(),
  background: z.object({
    prompt: z.string().min(10),
    negativePrompt: z.string().optional()
  }),
  elements: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().optional(),
        prompt: z.string().optional(),
        sourceIndex: z.number().int().optional(),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number()
      })
    )
    .optional()
});

type AssetInput = { label: string; url?: string };

const DEFAULT_FONTS = {
  title: "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif",
  body: "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif",
  display: "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
};

function logId() {
  return `pg_${Math.random().toString(16).slice(2)}`;
}

function isHexColor(value: string | undefined) {
  if (!value) return false;
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseColor(input?: string) {
  if (!input) return null;
  const value = input.trim();
  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r, g, b, a: 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }
  const rgbMatch = value.match(/^rgba?\\(([^)]+)\\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((v) => v.trim());
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length > 3 ? Number(parts[3]) : 1;
    if ([r, g, b, a].every((n) => Number.isFinite(n))) return { r, g, b, a };
  }
  return null;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }) {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) {
  const L1 = relativeLuminance(a);
  const L2 = relativeLuminance(b);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableColor(
  background: { r: number; g: number; b: number },
  candidates: Array<string | undefined>,
  minRatio: number
) {
  const parsed = candidates
    .map((c) => (typeof c === "string" ? { raw: c, rgb: parseColor(c) } : null))
    .filter((v): v is { raw: string; rgb: { r: number; g: number; b: number; a: number } } => Boolean(v?.rgb));
  let best = parsed[0];
  let bestRatio = best ? contrastRatio(background, best.rgb) : 0;
  for (const cand of parsed) {
    const ratio = contrastRatio(background, cand.rgb);
    if (ratio > bestRatio) {
      best = cand;
      bestRatio = ratio;
    }
  }
  if (best && bestRatio >= minRatio) return { color: best.raw, ratio: bestRatio, changed: true };
  if (best) return { color: best.raw, ratio: bestRatio, changed: true };
  return { color: "#ffffff", ratio: contrastRatio(background, { r: 255, g: 255, b: 255 }), changed: true };
}

function sampleBoxStats(
  png: PNG,
  box: { x: number; y: number; w: number; h: number },
  canvasWidth: number,
  canvasHeight: number
) {
  const sx = png.width / canvasWidth;
  const sy = png.height / canvasHeight;
  const left = clamp(Math.round(box.x * sx), 0, png.width - 1);
  const top = clamp(Math.round(box.y * sy), 0, png.height - 1);
  const right = clamp(Math.round((box.x + box.w) * sx), 0, png.width - 1);
  const bottom = clamp(Math.round((box.y + box.h) * sy), 0, png.height - 1);
  const cols = 6;
  const rows = 6;
  let count = 0;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let minLum = 1;
  let maxLum = 0;
  for (let yi = 0; yi < rows; yi += 1) {
    const y = clamp(Math.round(top + ((bottom - top) * (yi + 0.5)) / rows), 0, png.height - 1);
    for (let xi = 0; xi < cols; xi += 1) {
      const x = clamp(Math.round(left + ((right - left) * (xi + 0.5)) / cols), 0, png.width - 1);
      const idx = (y * png.width + x) * 4;
      const a = png.data[idx + 3];
      if (a < 16) continue;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      rSum += r;
      gSum += g;
      bSum += b;
      const lum = relativeLuminance({ r, g, b });
      minLum = Math.min(minLum, lum);
      maxLum = Math.max(maxLum, lum);
      count += 1;
    }
  }
  if (!count) return null;
  return {
    color: { r: Math.round(rSum / count), g: Math.round(gSum / count), b: Math.round(bSum / count), a: 1 },
    luminanceRange: maxLum - minLum
  };
}

async function readPngSafe(absPath: string) {
  try {
    const buf = await fs.readFile(absPath);
    return PNG.sync.read(buf);
  } catch {
    return null;
  }
}

function parseAssets(input?: string): AssetInput[] {
  if (!input) return [];
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const urlMatch = line.match(/https?:\/\/\S+/i);
      if (!urlMatch) return { label: line };
      const url = urlMatch[0];
      const label = line.replace(url, "").replace(/[|:：\-–—]/g, " ").trim() || url;
      return { label, url };
    });
}

function extFromMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("png")) return "png";
  return "png";
}

function buildAvoidBackgroundHint(boxes: Array<{ x: number; y: number; w: number; h: number }>, width: number, height: number) {
  if (!boxes.length) return "";
  const items = boxes.slice(0, 6).map((b) => {
    const x = Math.round((b.x / width) * 100);
    const y = Math.round((b.y / height) * 100);
    const w = Math.round((b.w / width) * 100);
    const h = Math.round((b.h / height) * 100);
    return `[x:${x}%, y:${y}%, w:${w}%, h:${h}%]`;
  });
  return [
    "布局约束：以下区域将放置文字，请保持背景干净、低纹理、低对比、避免亮点与复杂细节：",
    items.join(" ")
  ].join("\n");
}

function normalizeRatio(value: number, size: number) {
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) <= 1.01) return value * size;
  return value;
}

function normalizeBox(box: { x: number; y: number; w: number; h: number }, width: number, height: number) {
  const x = normalizeRatio(box.x, width);
  const y = normalizeRatio(box.y, height);
  const w = normalizeRatio(box.w, width);
  const h = normalizeRatio(box.h, height);
  return {
    x: clamp(Math.round(x), 0, width - 20),
    y: clamp(Math.round(y), 0, height - 20),
    w: clamp(Math.round(w), 20, width),
    h: clamp(Math.round(h), 20, height)
  };
}

function resolveFontSize(value: number | undefined, width: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  const v = value as number;
  const px = v <= 2 ? Math.round(v * width) : Math.round(v);
  return clamp(px, 12, Math.max(16, Math.round(width * 0.16)));
}

function formatListText(text: string) {
  const raw = text.trim();
  if (!raw) return raw;
  if (raw.includes("\n") && raw.includes("•")) return raw;
  const parts = raw
    .split(/[\n;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length <= 1) return raw.startsWith("•") ? raw : `• ${raw}`;
  return parts.map((item) => (item.startsWith("•") ? item : `• ${item}`)).join("\n");
}

function buildRectSvg({
  width,
  height,
  fillColor,
  borderColor,
  borderWidth,
  radius
}: {
  width: number;
  height: number;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const rx = Math.max(0, Math.round(radius ?? 0));
  const fill = fillColor?.trim() || "transparent";
  const stroke = borderColor?.trim();
  const strokeWidth = typeof borderWidth === "number" ? Math.max(0, borderWidth) : 0;
  const rect = `<rect x="0" y="0" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="${fill}"${
    stroke && strokeWidth > 0 ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""
  } />`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${rect}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildTextBackdropLayer({
  box,
  canvasWidth,
  canvasHeight,
  z,
  fontSize,
  style
}: {
  box: { x: number; y: number; w: number; h: number };
  canvasWidth: number;
  canvasHeight: number;
  z: number;
  fontSize: number;
  style?: {
    fillColor?: string;
    borderColor?: string;
    borderWidth?: number;
    radius?: number;
    padding?: number;
  };
}): PosterImageLayer {
  const pad = Math.max(6, Math.round(style?.padding ?? Math.max(10, Math.round(fontSize * 0.35))));
  const x = clamp(box.x - pad, 0, canvasWidth - 20);
  const y = clamp(box.y - pad, 0, canvasHeight - 20);
  const w = clamp(box.w + pad * 2, 20, canvasWidth);
  const h = clamp(box.h + pad * 2, 20, canvasHeight);
  const src = buildRectSvg({
    width: w,
    height: h,
    fillColor: style?.fillColor ?? "rgba(0,0,0,0.35)",
    borderColor: style?.borderColor ?? "rgba(255,255,255,0.08)",
    borderWidth: style?.borderWidth ?? 1,
    radius: Math.round(style?.radius ?? Math.max(10, Math.round(fontSize * 0.35)))
  });
  return {
    id: `layer_backdrop_${nanoid()}`,
    type: "image",
    x,
    y,
    w,
    h,
    rotation: 0,
    z,
    src,
    role: "text_backdrop",
    locked: true
  };
}
function safeParseJson(raw: string) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("LLM response is not valid JSON");
  }
}

function resolveLlmEndpoint() {
  const base =
    process.env.GPT_I18N_BASE_URL ??
    process.env.NANOBANANA_3P_BASE_URL ??
    "https://genai-sg-og.tiktok-row.org";
  const url = new URL(base);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/gpt/openapi/online/v2/crawl";
  }
  return url;
}

function extractTextFromLlmResponse(json: any) {
  const content = json?.choices?.[0]?.message?.content ?? json?.data?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callStructureLlm({
  script,
  assets,
  styleHint,
  width,
  height
}: {
  script: string;
  assets: AssetInput[];
  styleHint?: string;
  width: number;
  height: number;
}) {
  const model = STRUCTURE_LLM_MODEL;
  const ak =
    (model === STRUCTURE_LLM_MODEL ? process.env.GPT_5_4_AK : undefined) ??
    process.env.GPT_5_1_AK ??
    process.env.GPT_I18N_AK ??
    process.env.NANOBANANA_AK ??
    process.env.NANOBANANA_3P_AK;
  if (!ak) throw new Error("Missing env GPT_I18N_AK (or NANOBANANA_AK)");

  const url = resolveLlmEndpoint();
  url.searchParams.set("ak", ak);

  const schemaExample = `{
  "plan": "技术方案（简短要点）",
  "textBlocks": [
    {
      "id": "title_1",
      "role": "title|subtitle|body|list|highlight|note",
      "text": "文本内容",
      "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.22,
      "fontSize": 64, "fontWeight": 700, "color": "#FFFFFF", "align": "left", "lineHeight": 1.1, "letterSpacing": 1.2, "opacity": 1
    }
  ],
  "palette": { "background": "#0b0c10", "primary": "#ffffff", "secondary": "#b9c0cc", "accent": "#00f5d4" },
  "fonts": { "title": "Noto Sans SC, ...", "body": "Noto Sans SC, ...", "display": "Noto Sans SC, ..." },
  "background": { "prompt": "背景生成提示词", "negativePrompt": "可选" },
  "elements": [
    {
      "id": "asset_1",
      "label": "元素描述",
      "prompt": "可选（如果需要生图）",
      "sourceIndex": 0,
      "x": 0.1, "y": 0.55, "w": 0.35, "h": 0.35
    }
  ]
}`;

  const prompt = [
    "你是海报结构理解与布局生成器，只输出 JSON。",
    "需要把输入脚本拆解成标题/正文/列表/重点，并生成可执行的布局方案。",
    "输出必须匹配以下 JSON schema：",
    schemaExample,
    "规则：",
    "1) 坐标全部使用 0-1 的相对比例。",
    "2) fontSize 用像素值。",
    "3) 不要输出 markdown，不要解释文字。",
    "4) textBlocks 至少包含标题。",
    "5) 版式必须精美、有秩序（参考 seede.ai 的风格）：对齐统一、字号节奏明确、留白克制、模块分区清晰。",
    "6) 从以下 4 个模板中选择一个并落实到 textBlocks：",
    "   A) 经典上下结构：标题区(上方1/4) → 正文区(中部) → 列表/CTA(下方)。",
    "   B) 左文右图：左侧文字列(标题+正文+列表)，右侧元素/装饰图；文本对齐统一。",
    "   C) 中央标题卡片：标题/副标题集中在中上，正文与列表在半透明卡片内。",
    "   D) 强对比分区：上部纯净留白用于标题，下部复杂背景放正文+列表（需衬底）。",
    "7) elements 只放需要出现在画面的素材或需生图的特殊元素。",
    "8) 阴影/描边/底图(backdrop)只在确实需要提升可读性时才使用，但复杂背景必须增强。",
    "9) 阴影/描边/底图的颜色必须与背景整体配色协调，避免脏黑遮挡；需要你完整定义颜色与透明度。",
    "10) 如果需要底图，请在 textBlocks[n].backdrop 中定义（enabled=true + fillColor/borderColor 等），且必须覆盖该文字块全部内容。",
    "11) 文本样式不要单一：可在标题/重点上使用字距(letterSpacing)、描边/阴影/轻微透明度等组合效果。",
    "12) 如果使用 elements 生图，请确保元素为透明背景或 SVG。",
    "13) 如果你的系统会分离 reasoning，请确保最终 JSON 出现在最终回答的 content 中。",
    "",
    `画布尺寸：${width}x${height}`,
    styleHint?.trim() ? `风格提示：${styleHint.trim()}` : "风格提示：延续当前产品的简洁科技感与高对比海报风格。",
    "输入脚本：",
    script.trim(),
    "",
    "素材清单（含可能的 URL，按顺序编号）：",
    assets.length
      ? assets.map((asset, index) => `#${index} ${asset.label}${asset.url ? ` (${asset.url})` : ""}`).join("\n")
      : "无"
  ].join("\n");

  const body = {
    stream: false,
    model,
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }]
      }
    ]
  };

  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const logId = logId();
      const startedAt = Date.now();
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TT-LOGID": logId },
        body: JSON.stringify(body)
      });

      const raw = await resp.text();
      const durationMs = Date.now() - startedAt;
      console.log(
        `[llm][structured] status=${resp.status} model=${model} attempt=${attempt}/${attempts} duration_ms=${durationMs} logid=${logId}`
      );
      if (!resp.ok) {
        console.error(`[llm][structured] error_status=${resp.status} logid=${logId} body=${raw?.slice(0, 500) ?? ""}`);
        throw new HttpError(resp.status, `LLM HTTP ${resp.status}: ${raw || "empty response"}`);
      }

      const json = JSON.parse(raw);
      const content = extractTextFromLlmResponse(json);
      if (!content || typeof content !== "string" || !content.trim()) {
        const message = json?.choices?.[0]?.message ?? json?.data?.choices?.[0]?.message;
        const finishReason = json?.choices?.[0]?.finish_reason ?? json?.data?.choices?.[0]?.finish_reason;
        const topKeys = json && typeof json === "object" ? Object.keys(json).slice(0, 30) : [];
        const msgKeys = message && typeof message === "object" ? Object.keys(message).slice(0, 30) : [];
        const contentType = typeof (message as any)?.content;
        const contentIsArray = Array.isArray((message as any)?.content);
        const contentLen = typeof (message as any)?.content === "string" ? (message as any).content.length : undefined;
        throw new Error(
          `LLM response empty content. finishReason=${String(finishReason)} topKeys=${topKeys.join(",")} msgKeys=${msgKeys.join(",")} contentType=${contentType} contentIsArray=${contentIsArray} contentLen=${String(
            contentLen
          )}`
        );
      }

      const parsed = safeParseJson(content);
      return LlmPlanSchema.parse(parsed);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function writeBase64Image({
  base64,
  mimeType,
  prefix
}: {
  base64: string;
  mimeType: string;
  prefix: string;
}) {
  const outDir = publicDir("generated-structured");
  await ensureDir(outDir);
  const id = `${prefix}_${nanoid()}`;
  const ext = extFromMimeType(mimeType);
  const filename = `${id}.${ext}`;
  const abs = path.join(outDir, filename);
  await fs.writeFile(abs, Buffer.from(base64, "base64"));
  return { url: `/generated-structured/${filename}`, filename };
}

async function downloadAsset(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Asset fetch failed ${resp.status}: ${url}`);
  const mimeType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buf = Buffer.from(await resp.arrayBuffer());
  return { mimeType, base64: buf.toString("base64") };
}

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const assets = parseAssets(body.assetsText);
    const width = body.size.width;
    const height = body.size.height;

    const plan = await callStructureLlm({
      script: body.script,
      assets,
      styleHint: body.styleHint,
      width,
      height
    });

  const textBoxes = plan.textBlocks.map((block) => normalizeBox(block, width, height)).map((box) => ({
    x: Math.max(0, box.x - Math.round(box.w * 0.05)),
    y: Math.max(0, box.y - Math.round(box.h * 0.08)),
    w: Math.min(width, box.w + Math.round(box.w * 0.1)),
    h: Math.min(height, box.h + Math.round(box.h * 0.16))
  }));
  const avoidRegionsHint = buildAvoidBackgroundHint(textBoxes, width, height);

  const background = await nanoBanana3pGenerateImage({
    text: plan.background.prompt,
    aspectRatio: `${width}:${height}`,
    imageSize: width * height > 2_000_000 ? "2K" : "1K",
    seedTag: `bg_${nanoid()}`,
    includeNegative: true,
    avoidRegionsHint
  });

  const backgroundFile = await writeBase64Image({
    base64: background.base64,
    mimeType: background.mimeType,
    prefix: "bg"
  });
  const backgroundUrl = backgroundFile.url;
  const backgroundAbs = path.join(publicDir("generated-structured"), backgroundFile.filename);
  const backgroundPng = await readPngSafe(backgroundAbs);

  const palette = plan.palette ?? {};
  const fonts = { ...DEFAULT_FONTS, ...(plan.fonts ?? {}) };
  const fallbackBg = parseColor(palette.background) ?? { r: 11, g: 12, b: 16, a: 1 };
  const readabilityLevel = body.readabilityLevel ?? "medium";
  const readabilityMap = {
    weak: { minRatio: 3.2 },
    medium: { minRatio: 4.0 },
    strong: { minRatio: 5.0 }
  } as const;
  const minRatio = readabilityMap[readabilityLevel].minRatio;

  const imageLayers: PosterImageLayer[] = [];
  const textLayers: PosterTextLayer[] = plan.textBlocks.map((block, index) => {
    const box = normalizeBox(block, width, height);
    const role = block.role;
    const fontFamily =
      role === "title"
        ? fonts.title
        : role === "highlight"
          ? fonts.display
          : fonts.body;
    const baseFontSize = resolveFontSize(
      block.fontSize,
      width,
      role === "title" ? Math.round(height * 0.07) : role === "highlight" ? Math.round(height * 0.05) : Math.round(height * 0.035)
    );
    const fontWeight = block.fontWeight ?? (role === "title" || role === "highlight" ? 800 : 500);
    const baseColor = isHexColor(block.color)
      ? (block.color as string)
      : role === "highlight"
        ? (isHexColor(palette.accent) ? (palette.accent as string) : "#00f5d4")
        : isHexColor(palette.primary)
          ? (palette.primary as string)
          : "#ffffff";
    const align = block.align ?? (role === "title" ? "left" : "left");
    const lineHeight =
      typeof block.lineHeight === "number" && block.lineHeight > 0.8 && block.lineHeight < 3 ? block.lineHeight : TEXT_LINE_HEIGHT;
    const text = role === "list" ? formatListText(block.text) : block.text;

    const fitted = fitTextInBox({
      text,
      box,
      align,
      fontSize: baseFontSize,
      minFontSize: Math.max(12, Math.round(baseFontSize * 0.6)),
      maxFontSize: Math.round(baseFontSize * 1.1),
      lineHeight,
      verticalAlign: role === "title" ? "top" : "center",
      autoGrow: true
    });

    const sampled = backgroundPng ? sampleBoxStats(backgroundPng, fitted, width, height) : null;
    const bgColor = sampled?.color ?? fallbackBg;
    const colorPick = pickReadableColor(bgColor, [baseColor, palette.primary, palette.secondary, palette.accent, "#ffffff", "#0b0c10"], minRatio);
    const color = colorPick.color;
    const ratio = colorPick.ratio;
    const complexBg = typeof sampled?.luminanceRange === "number" && sampled.luminanceRange > 0.35;
    const roleNeedsSafe = role === "body" || role === "list" || role === "note";
    const needEnhance = ratio < minRatio || (complexBg && roleNeedsSafe);
    const effectStroke = block.stroke ?? (needEnhance ? "rgba(0,0,0,0.45)" : undefined);
    const effectStrokeWidth = block.strokeWidth ?? (needEnhance ? 2 : undefined);
    const effectShadowColor = block.shadowColor ?? (needEnhance ? "rgba(0,0,0,0.6)" : undefined);
    const effectShadowBlur = block.shadowBlur ?? (needEnhance ? 10 : undefined);
    const effectShadowOffsetY = block.shadowOffsetY ?? (needEnhance ? 6 : undefined);
    const effectShadowOpacity = block.shadowOpacity ?? (needEnhance ? 0.6 : undefined);

    const textLayer: PosterTextLayer = {
      id: `layer_${block.id}`,
      type: "text",
      x: fitted.x,
      y: fitted.y,
      w: fitted.w,
      h: fitted.h,
      rotation: 0,
      z: 200 + index,
      text: fitted.text,
      fontFamily,
      fontSize: fitted.fontSize,
      fontWeight,
      color,
      align: fitted.align,
      lineHeight: fitted.lineHeight,
      letterSpacing: block.letterSpacing,
      opacity: typeof block.opacity === "number" ? clamp(block.opacity, 0, 1) : undefined,
      stroke: effectStroke,
      strokeWidth: effectStrokeWidth,
      shadowColor: effectShadowColor,
      shadowBlur: effectShadowBlur,
      shadowOffsetX: block.shadowOffsetX,
      shadowOffsetY: effectShadowOffsetY,
      shadowOpacity: effectShadowOpacity
    };

    if (block.backdrop?.enabled || needEnhance) {
      imageLayers.push(
        buildTextBackdropLayer({
          box: { x: textLayer.x, y: textLayer.y, w: textLayer.w, h: textLayer.h },
          canvasWidth: width,
          canvasHeight: height,
          z: textLayer.z - 1,
          fontSize: textLayer.fontSize,
          style: {
            fillColor: block.backdrop?.fillColor ?? "rgba(10,10,20,0.35)",
            borderColor: block.backdrop?.borderColor ?? "rgba(255,255,255,0.12)",
            borderWidth: block.backdrop?.borderWidth ?? 1,
            radius: block.backdrop?.radius ?? Math.max(12, Math.round(textLayer.fontSize * 0.35)),
            padding: block.backdrop?.padding
          }
        })
      );
    }

    return textLayer;
  });

  const elements = plan.elements ?? [];
  const MAX_ELEMENTS = 4;

    for (const [index, element] of elements.entries()) {
      if (index >= MAX_ELEMENTS) break;
      const box = normalizeBox(element, width, height);
      let src: string | null = null;
      let elementPrompt = element.prompt;
      const asset = typeof element.sourceIndex === "number" ? assets[element.sourceIndex] : undefined;

      if (asset?.url) {
        const downloaded = await downloadAsset(asset.url);
        const saved = await writeBase64Image({
          base64: downloaded.base64,
          mimeType: downloaded.mimeType,
          prefix: "asset"
        });
        src = saved.url;
      } else {
        if (!elementPrompt) {
          const label = element.label ?? asset?.label ?? "decorative element";
          elementPrompt = `${label}，与海报主风格一致，真实光影与细节，单体元素，透明背景/alpha 通道。`;
        }
        const generated = await nanoBanana3pGenerateImage({
          text: `${elementPrompt}\n透明背景/alpha 通道，禁止实心背景或边框。`,
          aspectRatio: `${Math.max(1, Math.round(box.w))}:${Math.max(1, Math.round(box.h))}`,
          imageSize: "1K",
          seedTag: `el_${nanoid()}`,
          includeNegative: true,
          transparent: true
        });
        const saved = await writeBase64Image({
          base64: generated.base64,
          mimeType: generated.mimeType,
          prefix: "element"
        });
        src = saved.url;
      }

      if (!src) continue;
      imageLayers.push({
        id: `layer_${element.id}`,
        type: "image",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        rotation: 0,
        z: 120 + index,
        src,
        role: "asset"
      });
    }

    const id = `proj_${nanoid()}`;
  const project: PosterProject = {
      id,
      createdAt: new Date().toISOString(),
      inputText: [
        "脚本:",
        body.script,
        "",
        "素材:",
        assets.length ? assets.map((item, i) => `#${i} ${item.label}${item.url ? ` (${item.url})` : ""}`).join("\n") : "无"
      ].join("\n"),
      canvas: {
        width,
        height,
        background: { url: backgroundUrl }
      },
      meta: {
        provider: STRUCTURE_LLM_MODEL,
        prompt: plan.background.prompt,
        negativePrompt: plan.background.negativePrompt,
        params: {
          plan: plan.plan,
          layout: plan.textBlocks,
          elements: plan.elements,
          palette: plan.palette,
          fonts: plan.fonts,
          backgroundUrl
        }
      },
    layers: [...imageLayers, ...textLayers]
  };

    await writeJson(dataDir("projects", `${id}.json`), project);

    return NextResponse.json({
      id,
      plan: plan.plan,
      background: { url: backgroundUrl, prompt: plan.background.prompt },
      elements: imageLayers.map((layer) => ({ id: layer.id, src: layer.src }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
