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
      lineHeight: z.number().optional()
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
    (model === STRUCTURE_LLM_MODEL ? process.env.GPT_5_1_AK : undefined) ??
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
      "fontSize": 64, "fontWeight": 700, "color": "#FFFFFF", "align": "left", "lineHeight": 1.1
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
    "5) elements 只放需要出现在画面的素材或需生图的特殊元素。",
    "6) 如果你的系统会分离 reasoning，请确保最终 JSON 出现在最终回答的 content 中。",
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

    const background = await nanoBanana3pGenerateImage({
      text: plan.background.prompt,
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

    const palette = plan.palette ?? {};
    const fonts = { ...DEFAULT_FONTS, ...(plan.fonts ?? {}) };

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
    const color = isHexColor(block.color)
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

    return {
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
      lineHeight: fitted.lineHeight
    };
  });

    const imageLayers: PosterImageLayer[] = [];
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
          elementPrompt = `${label}，与海报主风格一致，真实光影与细节，单体元素。`;
        }
        const generated = await nanoBanana3pGenerateImage({
          text: elementPrompt,
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
        provider: "gpt-5.1-2025-11-13",
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
