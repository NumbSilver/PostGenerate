import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, publicDir, writeJson, dataDir } from "@/lib/storage";
import { nanoBanana3pGenerateImage } from "@/lib/nanobanana-3p";
import { fitTextInBox, TEXT_LINE_HEIGHT } from "@/lib/text-alignment";
import type { PosterImageLayer, PosterProject, PosterTextLayer } from "@/lib/types";

export const runtime = "nodejs";

const STRUCTURE_LLM_MODEL = "gpt-5.1-2025-11-13";

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
  size: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096)
  })
});

const BoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});

const CommandSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("text"),
    id: z.string().min(1),
    role: z.enum(["title", "subtitle", "body", "list", "highlight", "note"]),
    text: z.string().min(1),
    box: BoxSchema,
    style: z
      .object({
        fontSize: z.number().optional(),
        fontWeight: z.number().optional(),
        color: z.string().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        lineHeight: z.number().optional(),
        stroke: z.string().optional(),
        strokeWidth: z.number().optional(),
        shadowColor: z.string().optional(),
        shadowBlur: z.number().optional(),
        shadowOffsetX: z.number().optional(),
        shadowOffsetY: z.number().optional(),
        shadowOpacity: z.number().optional()
      })
      .optional(),
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
  }),
  z.object({
    op: z.literal("asset"),
    id: z.string().min(1),
    assetIndex: z.number().int().min(0),
    box: BoxSchema
  }),
  z.object({
    op: z.literal("generated"),
    id: z.string().min(1),
    label: z.string().optional(),
    prompt: z.string().min(10),
    box: BoxSchema
  }),
  z.object({
    op: z.literal("rect"),
    id: z.string().min(1),
    role: z.enum(["title", "subtitle", "body", "list", "highlight", "note"]).optional(),
    box: BoxSchema,
    style: z
      .object({
        fillColor: z.string().optional(),
        borderColor: z.string().optional(),
        borderWidth: z.number().optional(),
        radius: z.number().optional()
      })
      .optional()
  })
]);

const LlmLayoutSchema = z.object({
  plan: z.string().min(1),
  layoutCode: z.string().min(20),
  background: z.object({
    prompt: z.string().min(10),
    negativePrompt: z.string().optional()
  }),
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
  stylePolicy: z
    .object({
      contrast: z
        .object({
          minRatio: z.number().optional(),
          softRatio: z.number().optional()
        })
        .optional(),
      roles: z
        .record(
          z.object({
            enable: z.boolean().optional(),
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
        )
        .optional()
    })
    .optional(),
  commands: z.array(CommandSchema).min(1)
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isHexColor(value: string | undefined) {
  if (!value) return false;
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
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

function safeParseJson(raw: string) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
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

function extFromMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("png")) return "png";
  return "png";
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
  const pad = Math.max(4, Math.round(style?.padding ?? Math.max(8, Math.round(fontSize * 0.25))));
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

async function writeBase64Image({
  base64,
  mimeType,
  prefix
}: {
  base64: string;
  mimeType: string;
  prefix: string;
}) {
  const outDir = publicDir("generated-livecode");
  await ensureDir(outDir);
  const id = `${prefix}_${nanoid()}`;
  const ext = extFromMimeType(mimeType);
  const filename = `${id}.${ext}`;
  const abs = path.join(outDir, filename);
  await fs.writeFile(abs, Buffer.from(base64, "base64"));
  return { url: `/generated-livecode/${filename}`, filename };
}

async function downloadAsset(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Asset fetch failed ${resp.status}: ${url}`);
  const mimeType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buf = Buffer.from(await resp.arrayBuffer());
  return { mimeType, base64: buf.toString("base64") };
}

function buildDesignStyleHint(styleHint?: string) {
  const base =
    "延续 PostGenerate 的视觉风格：深色背景、强对比、克制留白、现代科技感、清晰层级（标题>重点>正文/列表），避免杂乱与低质噪点。";
  if (!styleHint?.trim()) return base;
  return `${base}\n用户补充风格：${styleHint.trim()}`;
}

async function callLiveCodeLlm({
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
}): Promise<{ llm: z.infer<typeof LlmLayoutSchema>; llmContent: string; llmResponsePreview: string; logId: string }> {
  const model = STRUCTURE_LLM_MODEL;
  const ak =
    (model === STRUCTURE_LLM_MODEL ? process.env.GPT_5_1_AK : undefined) ??
    process.env.GPT_I18N_AK ??
    process.env.NANOBANANA_AK ??
    process.env.NANOBANANA_3P_AK;
  if (!ak) throw new Error("Missing env GPT_I18N_AK (or NANOBANANA_AK)");

  const url = resolveLlmEndpoint();
  url.searchParams.set("ak", ak);

  const schemaExample = `{
  "plan": "技术方案（简短要点）",
  "layoutCode": "布局伪代码（仅用于人类阅读的排版示意字符串）",
  "background": { "prompt": "背景生图提示词（禁止出现任何文字）", "negativePrompt": "可选" },
  "palette": { "background": "#0b0c10", "primary": "#ffffff", "secondary": "#b9c0cc", "accent": "#00f5d4" },
  "fonts": { "title": "Noto Sans SC, ...", "body": "Noto Sans SC, ...", "display": "Noto Sans SC, ..." },
  "stylePolicy": {
    "contrast": { "minRatio": 4.0, "softRatio": 3.0 },
    "roles": {
      "title": { "enable": true, "shadowColor": "rgba(0,0,0,0.6)", "shadowBlur": 12, "shadowOffsetY": 6 },
      "body": { "enable": true, "backdrop": { "enabled": true, "fillColor": "rgba(10,10,20,0.35)", "borderColor": "rgba(255,255,255,0.12)", "borderWidth": 1, "radius": 16, "padding": 12 } }
    }
  },
  "commands": [
    {
      "op": "text",
      "id": "title_1",
      "role": "title|subtitle|body|list|highlight|note",
      "text": "文本内容",
      "box": { "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.22 },
      "style": { "fontSize": 64, "fontWeight": 800, "color": "#FFFFFF", "align": "left", "lineHeight": 1.1, "stroke": "rgba(0,0,0,0.45)", "strokeWidth": 2, "shadowColor": "rgba(0,0,0,0.6)", "shadowBlur": 12, "shadowOffsetY": 6, "shadowOpacity": 0.6 },
      "backdrop": { "enabled": false }
    },
    { "op": "asset", "id": "asset_1", "assetIndex": 0, "box": { "x": 0.1, "y": 0.55, "w": 0.35, "h": 0.35 } },
    { "op": "generated", "id": "icon_1", "label": "装饰图形", "prompt": "与整体风格一致的装饰元素，单体，真实光影", "box": { "x": 0.7, "y": 0.6, "w": 0.2, "h": 0.2 } },
    { "op": "rect", "id": "backdrop_1", "role": "body", "box": { "x": 0.06, "y": 0.24, "w": 0.88, "h": 0.14 }, "style": { "fillColor": "rgba(10,10,20,0.35)", "borderColor": "rgba(255,255,255,0.12)", "borderWidth": 1, "radius": 16 } }
  ]
}`;

  const prompt = [
    "你是“海报脚本理解→生成布局伪代码→生成受限布局指令”的生成器，只输出 JSON。",
    "",
    "目标：理解脚本结构（标题/正文/列表/重点），并输出两部分：",
    "1) layoutCode：可读的布局伪代码字符串（用于解释布局思路）。",
    "2) commands：受限的 JSON 指令（用于生成图层）。",
    "",
    "输出必须匹配以下 JSON schema 示例（字段名保持一致）：",
    schemaExample,
    "",
    "硬规则：",
    "1) 只输出 JSON，不要 markdown、不要解释。",
    "2) commands 的 box 坐标用 0-1 相对比例（或像素），但建议用 0-1。",
    "3) 背景 background.prompt 必须符合视觉风格，且严格禁止出现任何文字/字母/数字/logo/水印。",
    "4) 重点(highlight)要更醒目（字号/色彩/留白），列表(list)要有 bullet。",
    "5) 只有在确实需要增强可读性时才使用阴影/描边/底图，不要默认给所有文字加效果。",
    "6) 阴影/描边/底图的颜色必须与背景整体配色协调（例如：深色背景用冷色半透明底图，亮色背景用更浅底图），避免脏黑遮挡。",
    "7) 如果需要底图，请优先用 text.backdrop 或 rect（并定义 fill/border/opacity），不得留空。",
    "8) 请返回 stylePolicy（至少包含 contrast.minRatio 和常用 role 策略）。",
    "9) 如果 assets 中某条没有 URL，但必须出现在画面里，可以用 generated 命令生成元素。",
    "10) 如果你的系统会分离 reasoning，请确保最终 JSON 出现在最终回答的 content 中。",
    "",
    `画布尺寸：${width}x${height}`,
    `设计风格约束：${buildDesignStyleHint(styleHint)}`,
    "",
    "输入脚本：",
    script.trim(),
    "",
    "素材清单（按顺序编号）：",
    assets.length
      ? assets.map((asset, index) => `#${index} ${asset.label}${asset.url ? ` (${asset.url})` : ""}`).join("\n")
      : "无"
  ].join("\n");

  const body = {
    stream: false,
    model,
    max_tokens: 4000,
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
      const logIdValue = logId();
      const startedAt = Date.now();
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TT-LOGID": logIdValue },
        body: JSON.stringify(body)
      });

      const raw = await resp.text();
      const durationMs = Date.now() - startedAt;
      console.log(
        `[llm][livecode] status=${resp.status} model=${model} attempt=${attempt}/${attempts} duration_ms=${durationMs} logid=${logIdValue}`
      );
      if (!resp.ok) {
        console.error(`[llm][livecode] error_status=${resp.status} logid=${logIdValue} body=${raw?.slice(0, 500) ?? ""}`);
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
        const reasoningType = typeof (message as any)?.reasoning_content;
        const reasoningIsArray = Array.isArray((message as any)?.reasoning_content);
        const contentLen = typeof (message as any)?.content === "string" ? (message as any).content.length : undefined;
        const reasoningLen =
          typeof (message as any)?.reasoning_content === "string" ? (message as any).reasoning_content.length : undefined;
        throw new Error(
          `LLM response empty content. finishReason=${String(finishReason)} topKeys=${topKeys.join(",")} msgKeys=${msgKeys.join(",")} contentType=${contentType} contentIsArray=${contentIsArray} contentLen=${String(
            contentLen
          )} reasoningType=${reasoningType} reasoningIsArray=${reasoningIsArray} reasoningLen=${String(reasoningLen)}`
        );
      }

      const parsed = safeParseJson(content);
      const llm = LlmLayoutSchema.parse(parsed);
      return {
        llm,
        llmContent: content,
        llmResponsePreview: raw.slice(0, 4000),
        logId: logIdValue
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const assets = parseAssets(body.assetsText);
    const width = body.size.width;
    const height = body.size.height;

    const { llm, llmContent, llmResponsePreview, logId } = await callLiveCodeLlm({
      script: body.script,
      assets,
      styleHint: body.styleHint,
      width,
      height
    });

    const background = await nanoBanana3pGenerateImage({
      text: llm.background.prompt,
      aspectRatio: `${width}:${height}`,
      imageSize: width * height > 2_000_000 ? "2K" : "1K",
      seedTag: `bg_${nanoid()}`,
      includeNegative: true
    });
    const backgroundFile = await writeBase64Image({
      base64: background.base64,
      mimeType: background.mimeType,
      prefix: "bg"
    });
    const backgroundUrl = backgroundFile.url;

    const palette = llm.palette ?? {};
    const fonts = { ...DEFAULT_FONTS, ...(llm.fonts ?? {}) };
    const stylePolicy = llm.stylePolicy ?? {};
    const backgroundColor =
      parseColor(palette.background) ?? parseColor("#0b0c10") ?? { r: 11, g: 12, b: 16, a: 1 };
    const minRatio = stylePolicy.contrast?.minRatio ?? 4;
    const softRatio = stylePolicy.contrast?.softRatio ?? Math.max(3, minRatio - 1);

    const imageLayers: PosterImageLayer[] = [];
    const textLayers: PosterTextLayer[] = [];

    const MAX_ELEMENTS = 6;
    let elementCount = 0;

    for (const [index, cmd] of llm.commands.entries()) {
      if (cmd.op === "text") {
        const box = normalizeBox(cmd.box, width, height);
        const role = cmd.role;
        const fontFamily = role === "title" ? fonts.title : role === "highlight" ? fonts.display : fonts.body;
        const baseFontSize = resolveFontSize(
          cmd.style?.fontSize,
          width,
          role === "title"
            ? Math.round(height * 0.07)
            : role === "highlight"
              ? Math.round(height * 0.05)
              : role === "subtitle"
                ? Math.round(height * 0.04)
                : Math.round(height * 0.033)
        );
        const fontWeight = cmd.style?.fontWeight ?? (role === "title" || role === "highlight" ? 800 : 500);
        const color = isHexColor(cmd.style?.color)
          ? (cmd.style?.color as string)
          : role === "highlight"
            ? isHexColor(palette.accent)
              ? (palette.accent as string)
              : "#00f5d4"
            : isHexColor(palette.primary)
              ? (palette.primary as string)
              : "#ffffff";
        const align = cmd.style?.align ?? (role === "title" ? "left" : "left");
        const lineHeight =
          typeof cmd.style?.lineHeight === "number" && cmd.style.lineHeight > 0.8 && cmd.style.lineHeight < 3
            ? cmd.style.lineHeight
            : TEXT_LINE_HEIGHT;
        const text = role === "list" ? formatListText(cmd.text) : cmd.text;

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

        const rolePolicy = stylePolicy.roles?.[role];
        const textColorParsed = parseColor(color);
        const contrast =
          backgroundColor && textColorParsed ? contrastRatio(backgroundColor, textColorParsed) : minRatio + 1;
        const needsEnhance = contrast < minRatio;
        const softEnhance = contrast < softRatio;
        const shouldEnhance = (needsEnhance || softEnhance) && rolePolicy?.enable;

        const stroke = cmd.style?.stroke ?? (shouldEnhance ? rolePolicy?.stroke : undefined);
        const strokeWidth = cmd.style?.strokeWidth ?? (shouldEnhance ? rolePolicy?.strokeWidth : undefined);
        const shadowColor = cmd.style?.shadowColor ?? (shouldEnhance ? rolePolicy?.shadowColor : undefined);
        const shadowBlur = cmd.style?.shadowBlur ?? (shouldEnhance ? rolePolicy?.shadowBlur : undefined);
        const shadowOffsetX = cmd.style?.shadowOffsetX ?? (shouldEnhance ? rolePolicy?.shadowOffsetX : undefined);
        const shadowOffsetY = cmd.style?.shadowOffsetY ?? (shouldEnhance ? rolePolicy?.shadowOffsetY : undefined);
        const shadowOpacity = cmd.style?.shadowOpacity ?? (shouldEnhance ? rolePolicy?.shadowOpacity : undefined);

        const backdropStyle = cmd.backdrop?.enabled
          ? cmd.backdrop
          : shouldEnhance && rolePolicy?.backdrop?.enabled
            ? rolePolicy.backdrop
            : undefined;
        if (backdropStyle?.enabled) {
          imageLayers.push(
            buildTextBackdropLayer({
              box: fitted,
              canvasWidth: width,
              canvasHeight: height,
              z: 190 + index,
              fontSize: fitted.fontSize,
              style: {
                fillColor: backdropStyle.fillColor,
                borderColor: backdropStyle.borderColor,
                borderWidth: backdropStyle.borderWidth,
                radius: backdropStyle.radius,
                padding: backdropStyle.padding
              }
            })
          );
        }

        textLayers.push({
          id: `layer_${cmd.id}`,
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
          stroke,
          strokeWidth,
          shadowColor,
          shadowBlur,
          shadowOffsetX,
          shadowOffsetY,
          shadowOpacity
        });
        continue;
      }

      if (elementCount >= MAX_ELEMENTS) continue;
      elementCount += 1;

      if (cmd.op === "asset") {
        const asset = assets[cmd.assetIndex];
        if (!asset?.url) continue;
        const box = normalizeBox(cmd.box, width, height);
        const downloaded = await downloadAsset(asset.url);
        const saved = await writeBase64Image({
          base64: downloaded.base64,
          mimeType: downloaded.mimeType,
          prefix: "asset"
        });
        imageLayers.push({
          id: `layer_${cmd.id}`,
          type: "image",
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          rotation: 0,
          z: 120 + index,
          src: saved.url,
          role: "asset"
        });
        continue;
      }

      if (cmd.op === "generated") {
        const box = normalizeBox(cmd.box, width, height);
        const generated = await nanoBanana3pGenerateImage({
          text: cmd.prompt,
          aspectRatio: `${Math.max(1, Math.round(box.w))}:${Math.max(1, Math.round(box.h))}`,
          imageSize: "1K",
          seedTag: `el_${nanoid()}`,
          includeNegative: true
        });
        const saved = await writeBase64Image({
          base64: generated.base64,
          mimeType: generated.mimeType,
          prefix: "element"
        });
        imageLayers.push({
          id: `layer_${cmd.id}`,
          type: "image",
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          rotation: 0,
          z: 120 + index,
          src: saved.url,
          role: "asset"
        });
        continue;
      }

      if (cmd.op === "rect") {
        const box = normalizeBox(cmd.box, width, height);
        const src = buildRectSvg({
          width: box.w,
          height: box.h,
          fillColor: cmd.style?.fillColor,
          borderColor: cmd.style?.borderColor,
          borderWidth: cmd.style?.borderWidth,
          radius: cmd.style?.radius
        });
        imageLayers.push({
          id: `layer_${cmd.id}`,
          type: "image",
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          rotation: 0,
          z: 110 + index,
          src,
          role: "asset"
        });
        continue;
      }
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
        assets.length
          ? assets.map((item, i) => `#${i} ${item.label}${item.url ? ` (${item.url})` : ""}`).join("\n")
          : "无"
      ].join("\n"),
      canvas: {
        width,
        height,
        background: { url: backgroundUrl }
      },
      meta: {
        provider: "gpt-5.1-2025-11-13",
        prompt: llm.background.prompt,
        negativePrompt: llm.background.negativePrompt,
        params: {
          plan: llm.plan,
          layoutCode: llm.layoutCode,
          commands: llm.commands,
          palette: llm.palette,
          fonts: llm.fonts,
          stylePolicy: llm.stylePolicy,
          backgroundUrl
        }
      },
      layers: [...imageLayers, ...textLayers]
    };

    await writeJson(dataDir("projects", `${id}.json`), project);

    return NextResponse.json({
      id,
      plan: llm.plan,
      layoutCode: llm.layoutCode,
      background: { url: backgroundUrl, prompt: llm.background.prompt },
      elements: imageLayers.map((layer) => ({ id: layer.id, src: layer.src })),
      debug: {
        llmContent,
        llmResponsePreview,
        logId
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
