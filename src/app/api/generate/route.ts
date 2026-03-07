import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, publicDir } from "@/lib/storage";
import { generateFallbackPosterSvg } from "@/lib/svg-fallback";
import { nanoBanana3pGenerateImage } from "@/lib/nanobanana-3p";
import { buildFallbackTextLayout, evaluateLayoutQuality, nanoBanana3pGenerateTextLayout } from "@/lib/nanobanana-layout";
import { fitTextInBox } from "@/lib/text-alignment";
import type { PosterImageLayer, PosterTextLayer } from "@/lib/types";

export const runtime = "nodejs";

const TextContentSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  others: z.array(z.string().min(1)).max(8).optional()
});

const ImageModelSchema = z.enum(["gemini-3-pro-image-preview", "qwen-image", "gpt-image-1.5"]);

const BodySchema = z
  .object({
    text: z.string().min(1).optional(),
    stylePrompt: z.string().min(1).optional(),
    textContent: TextContentSchema.optional(),
    size: z.object({
      width: z.number().int().min(320).max(4096),
      height: z.number().int().min(320).max(4096)
    }),
    drawCount: z.number().int().min(1).max(12).default(1),
    includeNegative: z.boolean().optional().default(true),
    referenceImage: z
      .object({
        mimeType: z.string().min(1),
        base64: z.string().min(8)
      })
      .optional(),
    referenceMask: z
      .object({
        mimeType: z.string().min(1),
        base64: z.string().min(8)
      })
      .optional(),
    referenceStyle: z
      .object({
        palette: z.array(z.string().min(4)).min(1).max(12).optional()
      })
      .optional(),
    requestId: z.string().optional(),
    thinking: z
      .object({
        include_thoughts: z.boolean().optional(),
        budget_tokens: z.number().int().min(0).optional()
      })
      .optional(),
    imageModel: ImageModelSchema.optional()
  })
  .refine((body) => Boolean(body.stylePrompt?.trim() || body.text?.trim()), {
    message: "stylePrompt is required"
  });

type LayoutTextItem = {
  key: string;
  label: string;
  text: string;
};

const DEFAULT_TEXT_FONT = "Noto Sans SC, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif";

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function resolvedLayoutModel() {
  if (process.env.NANOBANANA_3P_LAYOUT_MODEL) return process.env.NANOBANANA_3P_LAYOUT_MODEL;
  const imageModel = process.env.NANOBANANA_3P_MODEL ?? "";
  if (imageModel === "qwen-image" || imageModel === "gpt-image-1.5") return "gemini-3-pro-preview-new";
  return imageModel || "gemini-3-pro-preview-new";
}

function buildTextItems(content: z.infer<typeof TextContentSchema>): LayoutTextItem[] {
  const items: LayoutTextItem[] = [{ key: "title", label: "主标题", text: content.title.trim() }];
  if (content.subtitle?.trim()) items.push({ key: "subtitle", label: "副标题", text: content.subtitle.trim() });
  (content.others ?? []).forEach((text, index) => {
    if (text.trim()) items.push({ key: `other_${index + 1}`, label: `其他文字${index + 1}`, text: text.trim() });
  });
  return items;
}

function buildBackgroundPrompt({
  stylePrompt,
  textItems
}: {
  stylePrompt: string;
  textItems: LayoutTextItem[];
}) {
  return [
    "背景风格描述：",
    stylePrompt,
    "",
    "文案语义（仅用于理解内容氛围，不允许渲染任何文字）：",
    ...textItems.map((item) => `${item.label}: ${item.text}`)
  ].join("\n");
}

function buildPosterATextPrompt({
  stylePrompt,
  textItems
}: {
  stylePrompt: string;
  textItems: LayoutTextItem[];
}) {
  return [
    "请生成一张可直接传播的海报，并在画面中清晰展示指定文案。",
    "文案必须可读、排版精美、层级清晰，不要遗漏任何一条。",
    "风格描述：",
    stylePrompt,
    "",
    "必须在海报中出现的文字：",
    ...textItems.map((item) => `${item.label}: ${item.text}`)
  ].join("\n");
}

function buildPosterBRemoveTextPrompt({
  stylePrompt,
  textItems
}: {
  stylePrompt: string;
  textItems: LayoutTextItem[];
}) {
  return [
    "请删除图片中所有文字、字母、数字、logo、水印。",
    "其余视觉元素、构图、光影、颜色、风格保持不变。",
    "严格要求：最终图中不能出现任何可识别文字。",
    "原图主题风格：",
    stylePrompt,
    "",
    "原图包含过的文案（用于删除参考）：",
    ...textItems.map((item) => `${item.label}: ${item.text}`)
  ].join("\n");
}

function extFromMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  return "png";
}

async function writeGeneratedImageFile({
  outDir,
  id,
  mimeType,
  base64
}: {
  outDir: string;
  id: string;
  mimeType: string;
  base64: string;
}) {
  const ext = extFromMimeType(mimeType);
  const filename = `${id}.${ext}`;
  const abs = path.join(outDir, filename);
  await fs.writeFile(abs, Buffer.from(base64, "base64"));
  return `/generated/${filename}`;
}

function buildGuideOverlayLayer({
  width,
  height,
  src
}: {
  width: number;
  height: number;
  src: string;
}): PosterImageLayer {
  return {
    id: `layer_${nanoid()}`,
    type: "image",
    x: 0,
    y: 0,
    w: width,
    h: height,
    rotation: 0,
    z: 1,
    src,
    opacity: 0.5,
    visible: true,
    locked: true,
    role: "guide_b_overlay"
  };
}

function buildTextLayers({
  width,
  height,
  textItems,
  layout
}: {
  width: number;
  height: number;
  textItems: LayoutTextItem[];
  layout: { blocks: Array<{ key: string; x: number; y: number; w: number; h: number; fontSize: number; fontWeight: number; color: string; align: "left" | "center" | "right"; rotation: number }> };
}): PosterTextLayer[] {
  const textMap = new Map(textItems.map((item) => [item.key, item.text]));
  const layers: PosterTextLayer[] = [];
  layout.blocks.forEach((block, index) => {
    const text = textMap.get(block.key);
    if (!text) return;
    const x = clamp(Math.round(block.x), 0, Math.max(0, width - 20));
    const y = clamp(Math.round(block.y), 0, Math.max(0, height - 20));
    const w = clamp(Math.round(block.w), 20, Math.max(20, width - x));
    const h = clamp(Math.round(block.h), 20, Math.max(20, height - y));
    const fitted = fitTextInBox({
      text,
      box: { x, y, w, h },
      align: block.align,
      fontSize: clamp(Math.round(block.fontSize), 12, Math.round(height * 0.25)),
      maxFontSize: Math.round(height * 0.25),
      minFontSize: 12
    });
    layers.push({
      id: `layer_${nanoid()}`,
      type: "text",
      x: fitted.x,
      y: fitted.y,
      w: fitted.w,
      h: fitted.h,
      rotation: clamp(block.rotation, -45, 45),
      z: Date.now() + index,
      text: fitted.text,
      fontFamily: DEFAULT_TEXT_FONT,
      fontSize: fitted.fontSize,
      fontWeight: clamp(Math.round(block.fontWeight), 400, 900),
      color: block.color || "#FFFFFF",
      align: fitted.align,
      lineHeight: fitted.lineHeight
    });
  });
  return layers;
}

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());
  const { width, height } = body.size;
  const stylePrompt = body.stylePrompt?.trim() || body.text!.trim();
  const content = body.textContent ?? { title: body.text?.trim() || "主标题" };
  const textItems = buildTextItems(content);

  const outDir = publicDir("generated");
  await ensureDir(outDir);

  const aspectRatio = toAspectRatio(width, height);
  const candidates = [];
  const drawCount = body.drawCount;
  for (let i = 0; i < drawCount; i++) {
    const seed = randomSeed();
    const id = `cand_${nanoid()}`;
    const seedTag = body.requestId ? `${body.requestId}_${i}` : `seed_${seed}_${i}`;

    let layoutError: string | undefined;
    const fallbackLayout = buildFallbackTextLayout({ canvas: { width, height }, textItems });
    const fallbackQuality = evaluateLayoutQuality({ layout: fallbackLayout, canvas: { width, height }, textItems });
    const layoutResult =
      (await nanoBanana3pGenerateTextLayout({
        stylePrompt,
        canvas: { width, height },
        textItems,
        seedTag: `${seedTag}_layout`,
        thinking: body.thinking
          ? { include_thoughts: body.thinking.include_thoughts, budget_tokens: body.thinking.budget_tokens }
          : undefined
      }).catch((error) => {
        layoutError = error instanceof Error ? error.message : String(error);
        return {
          layout: fallbackLayout,
          quality: { ...fallbackQuality, retryUsed: false, attempts: 1 }
        };
      })) ?? {
      layout: fallbackLayout,
      quality: { ...fallbackQuality, retryUsed: false, attempts: 1 }
    };
    const layout = layoutResult.layout;
    const layoutQuality = layoutResult.quality;

    let imageUrl: string;
    let editorBackgroundUrl: string;
    let layers: Array<PosterTextLayer | PosterImageLayer>;
    let prompt: string;
    let negativePrompt: string | undefined;
    let params: Record<string, unknown>;
    let provider = "NanoBanana3P_A2B";
    let nanoBananaError: string | undefined;

    const posterATextPrompt = buildPosterATextPrompt({ stylePrompt, textItems });
    const posterBRemoveTextPrompt = buildPosterBRemoveTextPrompt({ stylePrompt, textItems });
    try {
      const genA = await nanoBanana3pGenerateImage({
        text: posterATextPrompt,
        aspectRatio,
        width,
        height,
        seedTag: `${seedTag}_a`,
        modelOverride: body.imageModel,
        includeNegative: false,
        referenceImage: body.imageModel === "gpt-image-1.5" ? undefined : body.referenceImage,
        referenceMask: undefined,
        referenceStyle: body.referenceStyle,
        thinking: body.thinking
          ? { include_thoughts: body.thinking.include_thoughts, budget_tokens: body.thinking.budget_tokens }
          : undefined
      });

      const posterAUrl = await writeGeneratedImageFile({
        outDir,
        id: `${id}_A`,
        mimeType: genA.mimeType,
        base64: genA.base64
      });

      const genB = await nanoBanana3pGenerateImage({
        text: posterBRemoveTextPrompt,
        aspectRatio,
        width,
        height,
        seedTag: `${seedTag}_b`,
        modelOverride: body.imageModel,
        includeNegative: true,
        referenceImage: { mimeType: genA.mimeType, base64: genA.base64 },
        referenceMask: body.referenceMask,
        referenceStyle: body.referenceStyle,
        thinking: body.thinking
          ? { include_thoughts: body.thinking.include_thoughts, budget_tokens: body.thinking.budget_tokens }
          : undefined
      });

      const posterBUrl = await writeGeneratedImageFile({
        outDir,
        id: `${id}_B`,
        mimeType: genB.mimeType,
        base64: genB.base64
      });

      prompt = posterATextPrompt;
      negativePrompt = genB.negativePrompt;
      imageUrl = posterBUrl;
      editorBackgroundUrl = posterAUrl;
      layers = [buildGuideOverlayLayer({ width, height, src: posterBUrl }), ...buildTextLayers({ width, height, textItems, layout })];
      params = {
        model: body.imageModel ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        aspectRatio,
        seed,
        logIdA: genA.logId,
        logIdB: genB.logId,
        posterAUrl,
        posterBUrl,
        promptA: posterATextPrompt,
        promptB: posterBRemoveTextPrompt,
        apiModeA: (genA.params as Record<string, unknown> | undefined)?.apiMode,
        apiModeB: (genB.params as Record<string, unknown> | undefined)?.apiMode,
        imageModelA: (genA.params as Record<string, unknown> | undefined)?.imageModel,
        imageModelB: (genB.params as Record<string, unknown> | undefined)?.imageModel,
        layoutModel: resolvedLayoutModel(),
        layoutRationale: layout.rationale,
        layoutQuality,
        layoutQualityScore: layoutQuality.score,
        layoutQualityPassed: layoutQuality.passed,
        layoutQualityIssues: layoutQuality.issues,
        layoutAttempts: layoutQuality.attempts,
        layoutRetryUsed: layoutQuality.retryUsed,
        layoutError,
        layoutBlocks: layout.blocks,
        generationParams: genA.params ?? {},
        editParams: genB.params ?? {}
      };
    } catch (error) {
      nanoBananaError = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[generate] A2B pipeline failed:", nanoBananaError);
      const fallback = generateFallbackPosterSvg({ width, height, seed });
      prompt = buildBackgroundPrompt({ stylePrompt, textItems });
      negativePrompt = fallback.negativePrompt;
      const filename = `${id}_fallback.svg`;
      const abs = path.join(outDir, filename);
      await fs.writeFile(abs, fallback.svg, "utf8");
      imageUrl = `/generated/${filename}`;
      editorBackgroundUrl = imageUrl;
      layers = buildTextLayers({ width, height, textItems, layout });
      params = {
        model: body.imageModel ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        imageModel: body.imageModel ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        seed,
        fallback: true,
        palette: fallback.palette,
        nanoBananaError,
        layoutRationale: layout.rationale,
        layoutQuality,
        layoutQualityScore: layoutQuality.score,
        layoutQualityPassed: layoutQuality.passed,
        layoutQualityIssues: layoutQuality.issues,
        layoutAttempts: layoutQuality.attempts,
        layoutRetryUsed: layoutQuality.retryUsed,
        layoutError,
        layoutBlocks: layout.blocks
      };
      provider = "FallbackSVG";
    }

    candidates.push({
      id,
      imageUrl,
      editorBackgroundUrl,
      layers,
      meta: { provider: `${provider}+Layout`, prompt, negativePrompt, params }
    });
  }

  return NextResponse.json({ candidates });
}

function toAspectRatio(width: number, height: number) {
  const ratio = width / height;
  const supported = [
    { ar: "21:9", v: 21 / 9 },
    { ar: "16:9", v: 16 / 9 },
    { ar: "4:3", v: 4 / 3 },
    { ar: "3:2", v: 3 / 2 },
    { ar: "1:1", v: 1 },
    { ar: "9:16", v: 9 / 16 },
    { ar: "3:4", v: 3 / 4 },
    { ar: "2:3", v: 2 / 3 },
    { ar: "5:4", v: 5 / 4 },
    { ar: "4:5", v: 4 / 5 }
  ];
  let best = supported[0]!;
  let bestDiff = Infinity;
  for (const option of supported) {
    const diff = Math.abs(ratio - option.v);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = option;
    }
  }
  return best.ar;
}
