import { z } from "zod";
import type { PosterLayoutPlan } from "@/lib/types";
import type { NanoBanana3pThinking } from "@/lib/nanobanana-3p";

type LayoutTextItem = {
  key: string;
  label: string;
  text: string;
};

export type LayoutQuality = {
  score: number;
  issues: string[];
  passed: boolean;
  retryUsed: boolean;
  attempts: number;
};

export type LayoutGenerationResult = {
  layout: PosterLayoutPlan;
  quality: LayoutQuality;
};

const ResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z
        .object({
          content: z.string().optional(),
          multimodal_contents: z.array(z.any()).optional()
        })
        .optional()
    })
  )
});

const LayoutSchema = z.object({
  blocks: z.array(
    z.object({
      key: z.string().min(1),
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
      fontSize: z.number(),
      fontWeight: z.number().optional(),
      color: z.string().optional(),
      align: z.enum(["left", "center", "right"]).optional(),
      rotation: z.number().optional()
    })
  ),
  rationale: z.string().optional()
});

const QUALITY_PASS_SCORE = 80;

function normalizeThinking(thinking?: NanoBanana3pThinking) {
  if (!thinking) return undefined;
  const budget = thinking.budget_tokens;
  if (budget === 0) return { include_thoughts: Boolean(thinking.include_thoughts), budget_tokens: 0 };
  if (typeof budget === "number" && budget < 1024) return { include_thoughts: Boolean(thinking.include_thoughts), budget_tokens: 1024 };
  return { include_thoughts: thinking.include_thoughts ?? true, budget_tokens: budget ?? 8192 };
}

function baseUrls() {
  const preferred = process.env.NANOBANANA_3P_BASE_URL ?? "https://genai-sg-og.tiktok-row.org";
  const fallback = process.env.NANOBANANA_3P_FALLBACK_BASE_URL;
  return fallback ? [preferred, fallback] : [preferred];
}

function ak() {
  const value = process.env.NANOBANANA_3P_AK;
  if (!value) throw new Error("Missing env NANOBANANA_3P_AK");
  return value;
}

function model() {
  const layoutModel = process.env.NANOBANANA_3P_LAYOUT_MODEL;
  if (layoutModel) return layoutModel;
  const imageModel = process.env.NANOBANANA_3P_MODEL ?? "";
  if (imageModel === "qwen-image" || imageModel === "gpt-image-1.5") return "gemini-3-pro-preview-new";
  return imageModel || "gemini-3-pro-preview-new";
}

function logId(input?: string) {
  return input ?? process.env.NANOBANANA_3P_LOGID ?? `pg_${Math.random().toString(16).slice(2)}`;
}

function extractTextParts(multimodalContents: unknown[]) {
  return multimodalContents
    .map((part) => ((part as any)?.type === "text" ? (part as any)?.text : null))
    .filter((text): text is string => typeof text === "string");
}

function stripFence(text: string) {
  const raw = text.trim();
  if (!raw.startsWith("```")) return raw;
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseLooseJsonObject(text: string) {
  const raw = stripFence(text);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`Layout JSON parse failed: ${raw.slice(0, 220)}`);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
}

function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.w, b.x + b.w);
  if (right <= left) return 0;
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function fallbackLayout({
  canvas,
  textItems
}: {
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
}): PosterLayoutPlan {
  const sidePadding = Math.round(canvas.width * 0.08);
  const maxWidth = canvas.width - sidePadding * 2;
  const gap = Math.round(canvas.height * 0.02);
  const blocks: PosterLayoutPlan["blocks"] = [];

  let y = Math.round(canvas.height * 0.12);
  for (const item of textItems) {
    const sizeRatio = item.key === "title" ? 0.085 : item.key === "subtitle" ? 0.05 : 0.038;
    const fontSize = clamp(Math.round(canvas.height * sizeRatio), 28, 150);
    const lineLimit = item.key === "title" ? 2 : 3;
    const charsPerLine = item.key === "title" ? 12 : 18;
    const guessedLines = clamp(Math.ceil(item.text.length / charsPerLine), 1, lineLimit);
    const h = Math.round(fontSize * 1.25 * guessedLines);
    if (y + h > canvas.height - sidePadding) break;

    blocks.push({
      key: item.key,
      x: sidePadding,
      y,
      w: maxWidth,
      h,
      fontSize,
      fontWeight: item.key === "title" ? 800 : item.key === "subtitle" ? 650 : 500,
      color: "#FFFFFF",
      align: "left",
      rotation: 0
    });

    y += h + gap;
  }

  return {
    blocks,
    rationale: "fallback_layout"
  };
}

function sanitizeLayout({
  layout,
  canvas,
  textItems
}: {
  layout: z.infer<typeof LayoutSchema>;
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
}): PosterLayoutPlan {
  const validKeys = new Set(textItems.map((item) => item.key));
  const blocks = layout.blocks
    .filter((block) => validKeys.has(block.key))
    .map((block) => {
      const x = clamp(Math.round(block.x), 0, Math.max(0, canvas.width - 20));
      const y = clamp(Math.round(block.y), 0, Math.max(0, canvas.height - 20));
      const w = clamp(Math.round(block.w), 20, Math.max(20, canvas.width - x));
      const h = clamp(Math.round(block.h), 20, Math.max(20, canvas.height - y));
      return {
        key: block.key,
        x,
        y,
        w,
        h,
        fontSize: clamp(Math.round(block.fontSize), 12, Math.round(canvas.height * 0.25)),
        fontWeight: clamp(Math.round(block.fontWeight ?? 600), 400, 900),
        color: isHexColor(block.color ?? "") ? (block.color as string) : "#FFFFFF",
        align: block.align ?? "left",
        rotation: clamp(Math.round(block.rotation ?? 0), -45, 45)
      };
    });

  if (blocks.length === 0) return fallbackLayout({ canvas, textItems });
  return { blocks, rationale: layout.rationale };
}

function buildLayoutPrompt({
  stylePrompt,
  canvas,
  textItems,
  feedbackIssues
}: {
  stylePrompt: string;
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
  feedbackIssues?: string[];
}) {
  return [
    "你是资深海报排版设计师。仅输出 JSON，不要 markdown，不要解释。",
    `画布尺寸：${canvas.width}x${canvas.height}。`,
    "任务：为给定文案设计排版区块，用于后续程序精确渲染文字。",
    "必须逐字符保留原文，不得改写、不增删标点。",
    "输出结构必须是：{\"blocks\":[{\"key\":\"...\",\"x\":0,\"y\":0,\"w\":0,\"h\":0,\"fontSize\":0,\"fontWeight\":0,\"color\":\"#FFFFFF\",\"align\":\"left\",\"rotation\":0}],\"rationale\":\"...\"}",
    "约束：",
    "1) 所有区块必须完全在画布内；2) 不同区块避免重叠；3) 标题最大最醒目；4) 对比度要高；5) 颜色仅使用十六进制。",
    "6) align 仅能是 left/center/right；rotation 建议 -8 到 8。",
    `风格描述：${stylePrompt}`,
    "文案清单（key => text）：",
    ...textItems.map((item) => `- ${item.key} (${item.label}): ${item.text}`),
    ...(feedbackIssues?.length
      ? [
          "",
          "上一次方案存在以下问题，请修正后重新给出 JSON：",
          ...feedbackIssues.map((issue, index) => `${index + 1}. ${issue}`)
        ]
      : [])
  ].join("\n");
}

async function requestLayout({
  prompt,
  seedTag,
  thinking,
  attemptIndex
}: {
  prompt: string;
  seedTag?: string;
  thinking?: NanoBanana3pThinking;
  attemptIndex: number;
}): Promise<z.infer<typeof LayoutSchema>> {
  const normalizedThinking = normalizeThinking(thinking);
  const id = logId(seedTag ? `${seedTag}_a${attemptIndex}` : undefined);
  const body = {
    stream: false,
    model: model(),
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }]
      }
    ],
    response_modalities: ["TEXT"]
  };

  const errors: string[] = [];
  for (const base of baseUrls()) {
    const url = new URL("/gpt/openapi/online/multimodal/crawl", base);
    url.searchParams.set("ak", ak());

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TT-LOGID": id },
      body: JSON.stringify(normalizedThinking ? { ...body, thinking: normalizedThinking } : body)
    });
    const raw = await resp.text();
    if (!resp.ok) {
      errors.push(`attempt ${attemptIndex} ${base} HTTP ${resp.status}: ${raw}`);
      continue;
    }

    try {
      const parsed = ResponseSchema.parse(JSON.parse(raw));
      const message = parsed.choices[0]?.message;
      const payload = [message?.content ?? "", ...extractTextParts(message?.multimodal_contents ?? [])]
        .join("\n")
        .trim();
      const layoutObj = parseLooseJsonObject(payload);
      return LayoutSchema.parse(layoutObj);
    } catch (error) {
      errors.push(`attempt ${attemptIndex} ${base} parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join("\n\n"));
}

export function evaluateLayoutQuality({
  layout,
  canvas,
  textItems
}: {
  layout: PosterLayoutPlan;
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
}) {
  const textMap = new Map(textItems.map((item) => [item.key, item.text]));
  const issues: string[] = [];
  let score = 100;

  for (const item of textItems) {
    if (!layout.blocks.find((block) => block.key === item.key)) {
      score -= 20;
      issues.push(`缺少文案区块：${item.key}`);
    }
  }

  for (const block of layout.blocks) {
    const text = textMap.get(block.key);
    if (!text) continue;
    const lineHeight = 1.2;
    const avgCharWidth = Math.max(8, block.fontSize * 0.92);
    const charsPerLine = Math.max(1, Math.floor(block.w / avgCharWidth));
    const needLines = Math.max(1, Math.ceil(text.length / charsPerLine));
    const maxLines = Math.max(1, Math.floor(block.h / (block.fontSize * lineHeight)));
    if (needLines > maxLines) {
      const overflow = needLines - maxLines;
      const penalty = clamp(Math.round((overflow / maxLines) * 24), 6, 24);
      score -= penalty;
      issues.push(`区块 ${block.key} 可能溢出：预计 ${needLines} 行，容纳 ${maxLines} 行`);
    }
  }

  for (let i = 0; i < layout.blocks.length; i++) {
    for (let j = i + 1; j < layout.blocks.length; j++) {
      const a = layout.blocks[i]!;
      const b = layout.blocks[j]!;
      const overlap = overlapArea(a, b);
      if (overlap <= 0) continue;
      const ratio = overlap / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
      const penalty = clamp(Math.round(ratio * 50), 8, 30);
      score -= penalty;
      issues.push(`区块重叠：${a.key} 与 ${b.key}`);
    }
  }

  const title = layout.blocks.find((block) => block.key === "title");
  if (!title) {
    score -= 20;
    issues.push("主标题区块缺失");
  } else {
    const maxFontSize = Math.max(...layout.blocks.map((block) => block.fontSize));
    if (title.fontSize + 2 < maxFontSize) {
      score -= 8;
      issues.push("主标题字号不够突出");
    }
  }

  score = clamp(score, 0, 100);
  return {
    score,
    issues,
    passed: score >= QUALITY_PASS_SCORE
  };
}

export async function nanoBanana3pGenerateTextLayout({
  stylePrompt,
  canvas,
  textItems,
  seedTag,
  thinking
}: {
  stylePrompt: string;
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
  seedTag?: string;
  thinking?: NanoBanana3pThinking;
}): Promise<LayoutGenerationResult> {
  const prompt = buildLayoutPrompt({ stylePrompt, canvas, textItems });
  const firstRaw = await requestLayout({ prompt, seedTag, thinking, attemptIndex: 1 });
  const firstLayout = sanitizeLayout({ layout: firstRaw, canvas, textItems });
  const firstQuality = evaluateLayoutQuality({ layout: firstLayout, canvas, textItems });

  if (firstQuality.passed) {
    return {
      layout: firstLayout,
      quality: { ...firstQuality, retryUsed: false, attempts: 1 }
    };
  }

  const feedbackIssues = firstQuality.issues.slice(0, 6);
  const secondPrompt = buildLayoutPrompt({
    stylePrompt,
    canvas,
    textItems,
    feedbackIssues: feedbackIssues.length ? feedbackIssues : ["文字可能溢出或重叠，请优化可读性和层级。"]
  });

  try {
    const secondRaw = await requestLayout({ prompt: secondPrompt, seedTag, thinking, attemptIndex: 2 });
    const secondLayout = sanitizeLayout({ layout: secondRaw, canvas, textItems });
    const secondQuality = evaluateLayoutQuality({ layout: secondLayout, canvas, textItems });

    if (secondQuality.score > firstQuality.score) {
      return {
        layout: secondLayout,
        quality: { ...secondQuality, retryUsed: true, attempts: 2 }
      };
    }

    return {
      layout: firstLayout,
      quality: { ...firstQuality, retryUsed: true, attempts: 2 }
    };
  } catch (error) {
    return {
      layout: firstLayout,
      quality: {
        ...firstQuality,
        retryUsed: true,
        attempts: 2,
        issues: [...firstQuality.issues, `二次重排失败: ${error instanceof Error ? error.message : String(error)}`]
      }
    };
  }
}

export function buildFallbackTextLayout({
  canvas,
  textItems
}: {
  canvas: { width: number; height: number };
  textItems: LayoutTextItem[];
}) {
  return fallbackLayout({ canvas, textItems });
}
