import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, publicDir } from "@/lib/storage";
import { generateFallbackPosterSvg } from "@/lib/svg-fallback";
import { nanoBanana3pGenerateImage, nanoBanana3pInjectReferenceImage } from "@/lib/nanobanana-3p";
import {
  nanoBanana3pEstimateRegistration,
  nanoBanana3pExtractDiffCandidates,
  nanoBanana3pExtractOcrRegions,
  nanoBanana3pExtractRegionStyleHints,
  nanoBanana3pExtractTextBoxes,
  nanoBanana3pExtractVisualPlacementHints,
  type OcrRegion,
  type OcrTextStyleHint,
  type VisionDiffCandidate,
  type VisionRegistrationTransform,
  type VisionTextBox,
  type VisualPlacementHint
} from "@/lib/nanobanana-ocr";
import { fitTextInBox } from "@/lib/text-alignment";
import type { PosterImageLayer, PosterLayoutBlock, PosterTextLayer } from "@/lib/types";

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
const SERIF_TEXT_FONT = "Times New Roman, Georgia, STSong, serif";
const CURSIVE_TEXT_FONT = "Snell Roundhand, Brush Script MT, cursive";
const MONO_TEXT_FONT = "Menlo, Monaco, Consolas, monospace";

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
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

function buildPosterAInjectPrompt({
  stylePrompt,
  textItems
}: {
  stylePrompt: string;
  textItems: LayoutTextItem[];
}) {
  return [
    "你需要在保持原海报构图与文字完全不变的前提下，注入参考图的主体元素。",
    "严格要求：除新增参考主体外，其余区域（尤其是文字）保持一致，不得移动或重绘。",
    "风格描述：",
    stylePrompt,
    "",
    "原海报中的文字内容（必须保持原样）：",
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

function normalizeTextForMatch(input: string) {
  return input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function textSimilarity(expected: string, actual: string) {
  const a = normalizeTextForMatch(expected);
  const b = normalizeTextForMatch(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const bag = new Map<string, number>();
  for (const char of a) bag.set(char, (bag.get(char) ?? 0) + 1);
  let common = 0;
  for (const char of b) {
    const left = bag.get(char) ?? 0;
    if (left <= 0) continue;
    common += 1;
    bag.set(char, left - 1);
  }
  return common / Math.max(a.length, b.length);
}

function defaultFontWeight(key: string) {
  if (key === "title") return 800;
  if (key === "subtitle") return 650;
  return 500;
}

function resolveFontFamily(style?: OcrTextStyleHint) {
  if (style?.fontFamily === "serif") return SERIF_TEXT_FONT;
  if (style?.fontFamily === "cursive") return CURSIVE_TEXT_FONT;
  if (style?.fontFamily === "monospace") return MONO_TEXT_FONT;
  return DEFAULT_TEXT_FONT;
}

function parseHexColor(input: string) {
  if (!isHexColor(input)) return null;
  const hex = input.length === 4 ? `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}` : input;
  const value = hex.slice(1);
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function isNeutralColor(input: string) {
  const rgb = parseHexColor(input);
  if (!rgb) return true;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const delta = max - min;
  return delta <= 18;
}

function isVeryDarkOrLight(input: string) {
  const rgb = parseHexColor(input);
  if (!rgb) return false;
  const luma = rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
  return luma <= 42 || luma >= 235;
}

function shouldPreferCursive({ key, text }: { key: string; text: string }) {
  if (key !== "title") return false;
  const normalized = text.replace(/\s+/g, "");
  if (!normalized || normalized.length > 8) return false;
  return /^[A-Za-z]+$/.test(normalized);
}

function shouldPreferSerif(text: string) {
  const normalized = text.replace(/\s+/g, "");
  if (!normalized || normalized.length > 24) return false;
  return /^[A-Z0-9.:-]+$/.test(normalized);
}

function buildFallbackBlocks({
  textItems,
  width,
  height
}: {
  textItems: LayoutTextItem[];
  width: number;
  height: number;
}) {
  const blocks: PosterLayoutBlock[] = [];
  const sidePadding = Math.round(width * 0.08);
  const maxWidth = width - sidePadding * 2;
  const gap = Math.round(height * 0.022);
  let y = Math.round(height * 0.12);

  for (const item of textItems) {
    const sizeRatio = item.key === "title" ? 0.085 : item.key === "subtitle" ? 0.05 : 0.038;
    const fontSize = clamp(Math.round(height * sizeRatio), 24, Math.round(height * 0.18));
    const lineLimit = item.key === "title" ? 2 : 3;
    const charsPerLine = item.key === "title" ? 12 : 20;
    const guessedLines = clamp(Math.ceil(item.text.length / charsPerLine), 1, lineLimit);
    const blockHeight = Math.round(fontSize * 1.25 * guessedLines) + Math.round(fontSize * 0.35);
    if (y + blockHeight > height - sidePadding) break;

    blocks.push({
      key: item.key,
      x: sidePadding,
      y,
      w: maxWidth,
      h: blockHeight,
      fontSize,
      fontWeight: defaultFontWeight(item.key),
      color: "#FFFFFF",
      align: "left",
      rotation: 0
    });
    y += blockHeight + gap;
  }

  return blocks;
}

function buildBlocksFromOcr({
  textItems,
  ocrRegions,
  width,
  height
}: {
  textItems: LayoutTextItem[];
  ocrRegions: OcrRegion[];
  width: number;
  height: number;
}) {
  const fallbackBlocks = buildFallbackBlocks({ textItems, width, height });
  if (ocrRegions.length === 0) {
    return { blocks: fallbackBlocks, used: false, matchedKeys: [] as string[] };
  }

  const fallbackByKey = new Map(fallbackBlocks.map((block) => [block.key, block]));
  const sortedRegions = [...ocrRegions].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  const usedRegionIdx = new Set<number>();
  const matchedRegions = new Map<string, OcrRegion>();

  for (const item of textItems) {
    let bestScore = 0;
    let bestIndex = -1;
    for (let i = 0; i < sortedRegions.length; i++) {
      if (usedRegionIdx.has(i)) continue;
      const score = textSimilarity(item.text, sortedRegions[i]!.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestScore >= 0.5) {
      usedRegionIdx.add(bestIndex);
      matchedRegions.set(item.key, sortedRegions[bestIndex]!);
    }
  }

  const remainingRegions = sortedRegions.filter((_, index) => !usedRegionIdx.has(index));
  const missingItems = textItems.filter((item) => !matchedRegions.has(item.key));
  for (let i = 0; i < missingItems.length && i < remainingRegions.length; i++) {
    matchedRegions.set(missingItems[i]!.key, remainingRegions[i]!);
  }

  const blocks: PosterLayoutBlock[] = [];
  const matchedKeys: string[] = [];
  for (const item of textItems) {
    const fallback = fallbackByKey.get(item.key);
    const matched = matchedRegions.get(item.key);
    if (!matched) {
      if (fallback) blocks.push(fallback);
      continue;
    }

    matchedKeys.push(item.key);
    const padX = Math.max(4, Math.round(matched.w * 0.04));
    const padY = Math.max(2, Math.round(matched.h * 0.08));
    const x = clamp(Math.round(matched.x - padX), 0, Math.max(0, width - 20));
    const y = clamp(Math.round(matched.y - padY), 0, Math.max(0, height - 20));
    const w = clamp(Math.round(matched.w + padX * 2), 20, Math.max(20, width - x));
    const h = clamp(Math.round(matched.h + padY * 2), 20, Math.max(20, height - y));
    const fontSize = clamp(Math.round(matched.h * 0.78), 12, Math.round(height * 0.25));
    const rotation = clamp(Math.round(matched.angle), -45, 45);

    blocks.push({
      key: item.key,
      x,
      y,
      w,
      h,
      fontSize,
      fontWeight: fallback?.fontWeight ?? defaultFontWeight(item.key),
      color: fallback?.color ?? "#FFFFFF",
      align: fallback?.align ?? "left",
      rotation
    });
  }

  const existingKeys = new Set(blocks.map((block) => block.key));
  for (const block of fallbackBlocks) {
    if (existingKeys.has(block.key)) continue;
    blocks.push(block);
  }

  return { blocks, used: matchedKeys.length > 0, matchedKeys };
}

type PlacementSource = "visual" | "diff+ocr" | "diff" | "ocr" | "fallback";

type BoxWithAngle = {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
};

function sanitizeTextAngle(angle: number, w: number, h: number) {
  if (!Number.isFinite(angle)) return 0;
  let normalized = angle;
  while (normalized > 180) normalized -= 360;
  while (normalized < -180) normalized += 360;
  if (normalized > 90) normalized -= 180;
  if (normalized < -90) normalized += 180;
  normalized = clamp(normalized, -45, 45);
  if (Math.abs(normalized) < 2) return 0;
  if (w >= h * 1.8 && Math.abs(normalized) > 20) return 0;
  return normalized;
}

function unionBoxes(boxes: BoxWithAngle[]) {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  const weightedAngle =
    boxes.reduce((sum, box) => sum + box.angle * box.w * box.h, 0) /
    Math.max(
      1,
      boxes.reduce((sum, box) => sum + box.w * box.h, 0)
    );
  return {
    x: minX,
    y: minY,
    w: Math.max(8, maxX - minX),
    h: Math.max(8, maxY - minY),
    angle: clamp(weightedAngle, -45, 45)
  } satisfies BoxWithAngle;
}

function boxIoU(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function centerDistance(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.hypot(ax - bx, ay - by);
}

function boxAreaRatio(box: { w: number; h: number }, width: number, height: number) {
  return (box.w * box.h) / Math.max(1, width * height);
}

function toBox(region: OcrRegion): BoxWithAngle {
  return {
    x: region.x,
    y: region.y,
    w: region.w,
    h: region.h,
    angle: sanitizeTextAngle(region.angle, region.w, region.h)
  };
}

function splitBoxByLines(box: BoxWithAngle, lineCount: number) {
  const count = Math.max(1, lineCount);
  if (count === 1) return [box];
  const each = box.h / count;
  return Array.from({ length: count }, (_, index) => ({
    x: box.x,
    y: box.y + each * index,
    w: box.w,
    h: each,
    angle: box.angle
  }));
}

function applyRegistrationToBox({
  box,
  transform,
  width,
  height
}: {
  box: BoxWithAngle;
  transform: VisionRegistrationTransform;
  width: number;
  height: number;
}) {
  const centerX = width / 2;
  const centerY = height / 2;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const sx = (cx - centerX) * transform.scaleX;
  const sy = (cy - centerY) * transform.scaleY;
  const rad = (transform.rotation * Math.PI) / 180;
  const rx = sx * Math.cos(rad) - sy * Math.sin(rad);
  const ry = sx * Math.sin(rad) + sy * Math.cos(rad);
  const mappedCx = centerX + rx + transform.dx;
  const mappedCy = centerY + ry + transform.dy;

  const mappedW = Math.max(8, box.w * transform.scaleX);
  const mappedH = Math.max(8, box.h * transform.scaleY);
  const x = clamp(Math.round(mappedCx - mappedW / 2), 0, Math.max(0, width - 8));
  const y = clamp(Math.round(mappedCy - mappedH / 2), 0, Math.max(0, height - 8));
  const w = clamp(Math.round(mappedW), 8, Math.max(8, width - x));
  const h = clamp(Math.round(mappedH), 8, Math.max(8, height - y));
  return { x, y, w, h, angle: sanitizeTextAngle(box.angle + transform.rotation, w, h) } satisfies BoxWithAngle;
}

function transformOcrRegions({
  regions,
  transform,
  width,
  height
}: {
  regions: OcrRegion[];
  transform: VisionRegistrationTransform;
  width: number;
  height: number;
}) {
  if (transform.confidence < 0.35) return regions;
  return regions.map((region) => {
    const mapped = applyRegistrationToBox({
      box: toBox(region),
      transform,
      width,
      height
    });
    return {
      ...region,
      x: mapped.x,
      y: mapped.y,
      w: mapped.w,
      h: mapped.h,
      angle: mapped.angle
    };
  });
}

function transformDiffCandidates({
  candidates,
  transform,
  width,
  height
}: {
  candidates: VisionDiffCandidate[];
  transform: VisionRegistrationTransform;
  width: number;
  height: number;
}) {
  if (transform.confidence < 0.35) return candidates;
  return candidates.map((candidate) => {
    const mapped = applyRegistrationToBox({
      box: { ...candidate, angle: 0 },
      transform,
      width,
      height
    });
    return {
      ...candidate,
      x: mapped.x,
      y: mapped.y,
      w: mapped.w,
      h: mapped.h
    };
  });
}

function transformTextBoxes({
  boxes,
  transform,
  width,
  height
}: {
  boxes: VisionTextBox[];
  transform: VisionRegistrationTransform;
  width: number;
  height: number;
}) {
  if (transform.confidence < 0.35) return boxes;
  return boxes.map((box) => {
    const mapped = applyRegistrationToBox({
      box: { ...box, angle: sanitizeTextAngle(box.angle, box.w, box.h) },
      transform,
      width,
      height
    });
    return { ...box, x: mapped.x, y: mapped.y, w: mapped.w, h: mapped.h, angle: mapped.angle };
  });
}

function matchPrimaryOcrByKey({
  textItems,
  ocrRegions
}: {
  textItems: LayoutTextItem[];
  ocrRegions: OcrRegion[];
}) {
  const matches = new Map<string, { region: OcrRegion; score: number }>();
  const used = new Set<number>();
  const rankedRegions = [...ocrRegions];

  for (const item of textItems) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < rankedRegions.length; index++) {
      if (used.has(index)) continue;
      const score = textSimilarity(item.text, rankedRegions[index]!.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore >= 0.45) {
      used.add(bestIndex);
      matches.set(item.key, { region: rankedRegions[bestIndex]!, score: bestScore });
    }
  }

  const remaining = rankedRegions
    .map((region, index) => ({ region, index }))
    .filter((entry) => !used.has(entry.index))
    .map((entry) => entry.region)
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  for (const item of textItems) {
    if (matches.has(item.key)) continue;
    const next = remaining.shift();
    if (!next) break;
    matches.set(item.key, { region: next, score: 0.32 });
  }

  return matches;
}

function buildBlocksFromDiffDominant({
  textItems,
  fallbackBlocks,
  ocrRegions,
  diffCandidates,
  textBoxes,
  visualHints,
  width,
  height
}: {
  textItems: LayoutTextItem[];
  fallbackBlocks: PosterLayoutBlock[];
  ocrRegions: OcrRegion[];
  diffCandidates: VisionDiffCandidate[];
  textBoxes: VisionTextBox[];
  visualHints: VisualPlacementHint[];
  width: number;
  height: number;
}) {
  const fallbackByKey = new Map(fallbackBlocks.map((block) => [block.key, block]));
  const ocrPrimaryByKey = matchPrimaryOcrByKey({ textItems, ocrRegions });
  const visualByKey = new Map(visualHints.filter((hint) => hint.confidence >= 0.35).map((hint) => [hint.key, hint] as const));
  const sortedDiff = [...diffCandidates].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
  const usedDiff = new Set<number>();
  const filteredTextBoxes = textBoxes.filter((box) => {
    const areaRatio = boxAreaRatio(box, width, height);
    if (areaRatio < 0.0008) return false;
    if (areaRatio > 0.28) return false;
    if (box.h < height * 0.015) return false;
    return true;
  });
  const orderedTextBoxes = [...filteredTextBoxes].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

  const blocks: PosterLayoutBlock[] = [];
  const lineAnchorsByKey: Record<string, BoxWithAngle[]> = {};
  const sourceByKey: Record<string, PlacementSource> = {};

  const layoutSlots = new Map<string, VisionTextBox>();
  if (orderedTextBoxes.length > 0) {
    const topLimit = height * 0.38;
    const titleCandidate =
      orderedTextBoxes
        .filter((box) => box.y < topLimit)
        .sort((a, b) => b.h - a.h)[0] ??
      orderedTextBoxes.slice().sort((a, b) => b.h - a.h)[0];
    if (titleCandidate) layoutSlots.set("title", titleCandidate);
    const remaining = orderedTextBoxes.filter((box) => box !== titleCandidate);
    if (textItems.some((item) => item.key === "subtitle")) {
      const subtitleCandidate =
        remaining.find((box) => box.y > (titleCandidate?.y ?? 0) + (titleCandidate?.h ?? 0) * 0.4) ?? remaining[0];
      if (subtitleCandidate) layoutSlots.set("subtitle", subtitleCandidate);
    }
    const others = remaining.filter((box) => ![...layoutSlots.values()].includes(box)).sort((a, b) => a.y - b.y);
    let idx = 0;
    for (const item of textItems.filter((it) => it.key.startsWith("other_"))) {
      if (!layoutSlots.has(item.key) && idx < others.length) {
        layoutSlots.set(item.key, others[idx]!);
        idx += 1;
      }
    }
  }

  for (const item of textItems) {
    const fallback = fallbackByKey.get(item.key);
    const ocrMatch = ocrPrimaryByKey.get(item.key);
    const ocrRegion = ocrMatch?.region;
    const visual = visualByKey.get(item.key);
    const ocrBox = ocrRegion ? toBox(ocrRegion) : undefined;
    const visualBox = visual
      ? {
          x: visual.x,
          y: visual.y,
          w: visual.w,
          h: visual.h,
          angle: sanitizeTextAngle(visual.angle ?? 0, visual.w, visual.h)
        }
      : undefined;
    const ocrAreaRatio = ocrBox ? boxAreaRatio(ocrBox, width, height) : 0;
    const ocrQuality =
      ocrBox && ocrMatch
        ? clamp(ocrMatch.score * 0.7 + (ocrAreaRatio <= 0.22 ? 0.3 : Math.max(0, 0.3 - (ocrAreaRatio - 0.22) * 1.4)), 0, 1)
        : 0;
    const visualQuality = visual ? clamp(visual.confidence, 0, 1) : 0;
    const layoutBox = layoutSlots.get(item.key);
    const layoutQuality = layoutBox ? clamp(layoutBox.score ?? 0.6, 0, 1) : 0;
    const expectedLines = Math.max(1, item.text.split(/\n+/).filter(Boolean).length);
    const probe = ocrBox ?? fallback ?? { x: width * 0.1, y: height * 0.2, w: width * 0.8, h: height * 0.12 };
    let diffIndex = -1;
    let bestScore = -Infinity;

    for (let index = 0; index < sortedDiff.length; index++) {
      if (usedDiff.has(index)) continue;
      const diff = sortedDiff[index]!;
      const overlap = boxIoU(probe, diff);
      const dist = centerDistance(probe, diff) / Math.max(1, Math.hypot(width, height));
      const score = overlap * 1.6 + diff.score * 0.5 - dist;
      if (score > bestScore) {
        bestScore = score;
        diffIndex = index;
      }
    }

    const diffBox = diffIndex >= 0 ? { ...sortedDiff[diffIndex]!, angle: 0 } : undefined;
    if (diffIndex >= 0 && (diffBox || ocrBox)) usedDiff.add(diffIndex);

    let source: PlacementSource = "fallback";
    let finalBox: BoxWithAngle | undefined;
    if (visualBox && (ocrQuality < 0.44 || !ocrBox) && visualQuality >= 0.56) {
      finalBox = visualBox;
      source = "visual";
    } else if (layoutBox && ocrQuality < 0.44 && layoutQuality >= 0.5) {
      finalBox = { ...layoutBox, angle: sanitizeTextAngle(layoutBox.angle ?? 0, layoutBox.w, layoutBox.h) };
      source = "visual";
    } else if (diffBox && ocrBox) {
      const overlap = boxIoU(diffBox, ocrBox);
      const dist = centerDistance(diffBox, ocrBox);
      const allowDiffRefine = overlap >= 0.32 || dist <= Math.min(ocrBox.w, ocrBox.h) * 0.4;
      if (allowDiffRefine) {
        finalBox = {
          x: Math.round(diffBox.x * 0.15 + ocrBox.x * 0.85),
          y: Math.round(diffBox.y * 0.15 + ocrBox.y * 0.85),
          w: Math.round(diffBox.w * 0.15 + ocrBox.w * 0.85),
          h: Math.round(diffBox.h * 0.15 + ocrBox.h * 0.85),
          angle: clamp(ocrBox.angle, -45, 45)
        };
        source = "diff+ocr";
      } else {
        finalBox = ocrBox;
        source = "ocr";
      }
    } else if (diffBox) {
      finalBox = diffBox;
      source = "diff";
    } else if (ocrBox) {
      finalBox = ocrBox;
      source = "ocr";
    } else if (fallback) {
      finalBox = { ...fallback, angle: fallback.rotation };
      source = "fallback";
    }

    if (!finalBox) continue;
    const visualLines = (visual?.lines ?? []).filter((line) => line.confidence >= 0.5).map((line) => ({ ...line }));
    const lineAnchors =
      visualLines.length > 0
        ? visualLines
        : splitBoxByLines(finalBox, expectedLines).map((box) => ({
            x: clamp(Math.round(box.x), 0, Math.max(0, width - 8)),
            y: clamp(Math.round(box.y), 0, Math.max(0, height - 8)),
            w: clamp(Math.round(box.w), 8, Math.max(8, width - Math.round(box.x))),
            h: clamp(Math.round(box.h), 8, Math.max(8, height - Math.round(box.y))),
            angle: clamp(box.angle, -45, 45)
          }));

    const union = unionBoxes(lineAnchors);
    const target = union ?? finalBox;
    const x = clamp(Math.round(target.x), 0, Math.max(0, width - 20));
    const y = clamp(Math.round(target.y), 0, Math.max(0, height - 20));
    const w = clamp(Math.round(target.w), 20, Math.max(20, width - x));
    const h = clamp(Math.round(target.h), 20, Math.max(20, height - y));
    const sizeFromBox = h / Math.max(1, expectedLines) * 0.82;
    const fontSize = clamp(
      Math.round(visual?.fontSize ?? sizeFromBox ?? fallback?.fontSize ?? 42),
      12,
      Math.round(height * 0.25)
    );
    blocks.push({
      key: item.key,
      x,
      y,
      w,
      h,
      fontSize,
      fontWeight: clamp(Math.round(visual?.fontWeight ?? fallback?.fontWeight ?? defaultFontWeight(item.key)), 400, 900),
      color: isHexColor(visual?.color ?? "") ? (visual?.color as string) : fallback?.color ?? "#FFFFFF",
      align: visual?.align ?? fallback?.align ?? "left",
      rotation: Math.round(sanitizeTextAngle(visual?.angle ?? target.angle ?? 0, w, h))
    });
    lineAnchorsByKey[item.key] = lineAnchors;
    sourceByKey[item.key] = source;
  }

  const existingKeys = new Set(blocks.map((block) => block.key));
  for (const fallback of fallbackBlocks) {
    if (existingKeys.has(fallback.key)) continue;
    blocks.push(fallback);
    sourceByKey[fallback.key] = "fallback";
    lineAnchorsByKey[fallback.key] = [{ x: fallback.x, y: fallback.y, w: fallback.w, h: fallback.h, angle: fallback.rotation }];
  }

  const sourceSet = new Set(Object.values(sourceByKey));
  const placementSource: PlacementSource = sourceSet.has("visual")
    ? "visual"
    : sourceSet.has("diff+ocr")
    ? "diff+ocr"
    : sourceSet.has("diff")
      ? "diff"
      : sourceSet.has("ocr")
        ? "ocr"
        : "fallback";

  return { blocks, sourceByKey, placementSource, lineAnchorsByKey };
}

function buildTextLayers({
  width,
  height,
  textItems,
  layout,
  styleHints,
  sourceByKey,
  lineAnchorsByKey
}: {
  width: number;
  height: number;
  textItems: LayoutTextItem[];
  layout: { blocks: PosterLayoutBlock[] };
  styleHints?: Record<string, OcrTextStyleHint>;
  sourceByKey?: Record<string, PlacementSource>;
  lineAnchorsByKey?: Record<string, BoxWithAngle[]>;
}): PosterTextLayer[] {
  const textMap = new Map(textItems.map((item) => [item.key, item.text]));
  const titleStyle = styleHints?.title;
  const subtitleStyle = styleHints?.subtitle;
  const primaryColor = (() => {
    const candidates = [titleStyle?.color, subtitleStyle?.color];
    for (const candidate of candidates) {
      if (!candidate || !isHexColor(candidate)) continue;
      if (isNeutralColor(candidate) || isVeryDarkOrLight(candidate)) continue;
      return candidate;
    }
    return undefined;
  })();
  const layers: PosterTextLayer[] = [];
  layout.blocks.forEach((block, index) => {
    const text = textMap.get(block.key);
    if (!text) return;
    const style = styleHints?.[block.key];
    const x = clamp(Math.round(block.x), 0, Math.max(0, width - 20));
    const y = clamp(Math.round(block.y), 0, Math.max(0, height - 20));
    const w = clamp(Math.round(block.w), 20, Math.max(20, width - x));
    const h = clamp(Math.round(block.h), 20, Math.max(20, height - y));
    const align = style?.align ?? block.align;
    const source = sourceByKey?.[block.key] ?? "fallback";
    const strictAnchors = lineAnchorsByKey?.[block.key] ?? [];
    const union = unionBoxes(strictAnchors);
    const targetBox = union
      ? {
          x: clamp(Math.round(union.x), 0, Math.max(0, width - 20)),
          y: clamp(Math.round(union.y), 0, Math.max(0, height - 20)),
          w: clamp(Math.round(union.w), 20, Math.max(20, width - Math.round(union.x))),
          h: clamp(Math.round(union.h), 20, Math.max(20, height - Math.round(union.y)))
        }
      : { x, y, w, h };
    const lineCount = Math.max(1, text.split(/\n+/).filter(Boolean).length);
    const inferredFontSize = clamp(Math.round((targetBox.h / lineCount) * 0.78), 12, Math.round(height * 0.25));
    const hintedFontSize =
      typeof style?.fontSize === "number" ? clamp(Math.round(style.fontSize), 12, Math.round(height * 0.25)) : undefined;
    const baseFontSize =
      typeof hintedFontSize === "number"
        ? Math.max(Math.round(inferredFontSize * 0.72), hintedFontSize)
        : Math.max(inferredFontSize, clamp(Math.round(block.fontSize), 12, Math.round(height * 0.25)));
    const fitted = fitTextInBox({
      text,
      box: targetBox,
      align,
      fontSize: baseFontSize,
      maxFontSize: Math.round(height * 0.25),
      minFontSize: source === "fallback" ? 12 : Math.max(12, Math.round(inferredFontSize * 0.6)),
      paddingX: source === "fallback" ? undefined : Math.max(2, Math.round(targetBox.w * 0.015)),
      paddingY: source === "fallback" ? undefined : Math.max(1, Math.round(targetBox.h * 0.04)),
      verticalAlign: source === "fallback" ? "center" : "top",
      autoGrow: source !== "fallback"
    });
    let color = isHexColor(style?.color ?? "") ? (style?.color as string) : block.color || "#FFFFFF";
    if ((isNeutralColor(color) || isVeryDarkOrLight(color)) && primaryColor && block.key.startsWith("other_")) {
      color = primaryColor;
    }
    if ((isNeutralColor(color) || isVeryDarkOrLight(color)) && primaryColor && block.key === "subtitle") {
      const subtitleCandidate = styleHints?.subtitle?.color;
      color = isHexColor(subtitleCandidate ?? "") ? (subtitleCandidate as string) : primaryColor;
    }
    let fontFamily = resolveFontFamily(style);
    if (shouldPreferCursive({ key: block.key, text }) && style?.fontFamily !== "monospace") {
      fontFamily = CURSIVE_TEXT_FONT;
    } else if ((style?.fontFamily === "sans" || !style?.fontFamily) && shouldPreferSerif(text)) {
      fontFamily = SERIF_TEXT_FONT;
    }

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
      fontFamily,
      fontSize: fitted.fontSize,
      fontWeight: clamp(Math.round(style?.fontWeight ?? block.fontWeight), 400, 900),
      color,
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
    const fallbackBlocks = buildFallbackBlocks({ textItems, width, height });

    let imageUrl: string;
    let editorBackgroundUrl: string;
    let layers: Array<PosterTextLayer | PosterImageLayer>;
    let prompt: string;
    let negativePrompt: string | undefined;
    let params: Record<string, unknown>;
    let provider = "NanoBanana3P_A2B_OCR";
    let nanoBananaError: string | undefined;
    let ocrError: string | undefined;
    let referenceInjectionError: string | undefined;
    let referenceInjectionUsed = false;
    let referenceInjectionLogId: string | undefined;
    let referenceInjectionModel: string | undefined;
    let referenceInjectionPrompt: string | undefined;

    const posterATextPrompt = buildPosterATextPrompt({ stylePrompt, textItems });
    const posterBRemoveTextPrompt = buildPosterBRemoveTextPrompt({ stylePrompt, textItems });
    try {
      const genABase = await nanoBanana3pGenerateImage({
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
      let genA = genABase;
      if (body.referenceImage && body.imageModel === "gpt-image-1.5") {
        try {
          const injectPrompt = buildPosterAInjectPrompt({ stylePrompt, textItems });
          const injected = await nanoBanana3pInjectReferenceImage({
            baseImage: { mimeType: genABase.mimeType, base64: genABase.base64 },
            referenceImage: body.referenceImage,
            text: injectPrompt,
            aspectRatio,
            width,
            height,
            seedTag: `${seedTag}_a_inject`,
            modelOverride: body.imageModel
          });
          genA = injected;
          referenceInjectionUsed = true;
          referenceInjectionLogId = injected.logId;
          referenceInjectionModel = (injected.params as Record<string, unknown> | undefined)?.imageModel as
            | string
            | undefined;
          referenceInjectionPrompt = injectPrompt;
        } catch (error) {
          referenceInjectionError = error instanceof Error ? error.message : String(error);
        }
      }

      const posterAUrl = await writeGeneratedImageFile({
        outDir,
        id: `${id}_A`,
        mimeType: genA.mimeType,
        base64: genA.base64
      });

      let ocrUsed = false;
      let placementSource: PlacementSource = "fallback";
      let placementSourceByKey: Record<string, PlacementSource> = Object.fromEntries(
        textItems.map((item) => [item.key, "fallback" as PlacementSource])
      );
      let ocrMatchedKeys: string[] = [];
      let ocrRegionCount = 0;
      let ocrRegions: OcrRegion[] = [];
      let registeredOcrRegions: OcrRegion[] = [];
      let ocrRawText: string | undefined;
      let ocrLogId: string | undefined;
      let ocrModel: string | undefined;
      let diffError: string | undefined;
      let diffLogId: string | undefined;
      let diffModel: string | undefined;
      let diffRawText: string | undefined;
      let diffCandidates: VisionDiffCandidate[] = [];
      let registeredDiffCandidates: VisionDiffCandidate[] = [];
      let textBoxError: string | undefined;
      let textBoxLogId: string | undefined;
      let textBoxModel: string | undefined;
      let textBoxRawText: string | undefined;
      let textBoxes: VisionTextBox[] = [];
      let registeredTextBoxes: VisionTextBox[] = [];
      let registrationError: string | undefined;
      let registrationLogId: string | undefined;
      let registrationModel: string | undefined;
      let registrationRawText: string | undefined;
      let registrationTransform: VisionRegistrationTransform = {
        dx: 0,
        dy: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        confidence: 0
      };
      let styleHintError: string | undefined;
      let styleHintUsed = false;
      let styleHintLogId: string | undefined;
      let styleHintModel: string | undefined;
      let styleHintRawText: string | undefined;
      let styleHintCount = 0;
      let styleHintsByKey: Record<string, OcrTextStyleHint> | undefined;
      let styleHintPlacementRawText: string | undefined;
      let styleHintPlacementCount = 0;
      let rawOcrMatchByKey = new Map<string, { region: OcrRegion; score: number }>();
      let visualHints: VisualPlacementHint[] = [];
      let placementBlocks = fallbackBlocks;
      const fallbackByKey = new Map(fallbackBlocks.map((block) => [block.key, block] as const));
      let lineAnchorsByKey: Record<string, BoxWithAngle[]> = Object.fromEntries(
        textItems.map((item) => {
          const fallback = fallbackByKey.get(item.key);
          return [
            item.key,
            fallback ? [{ x: fallback.x, y: fallback.y, w: fallback.w, h: fallback.h, angle: fallback.rotation }] : []
          ];
        })
      );
      if (process.env.NANOBANANA_3P_OCR_ENABLED !== "0") {
        try {
          const ocr = await nanoBanana3pExtractOcrRegions({
            image: { mimeType: genA.mimeType, base64: genA.base64 },
            canvas: { width, height },
            seedTag: `${seedTag}_ocr`
          });
          ocrRegionCount = ocr.regions.length;
          ocrRegions = ocr.regions;
          ocrRawText = ocr.rawText;
          ocrLogId = ocr.logId;
          ocrModel = ocr.model;
          rawOcrMatchByKey = matchPrimaryOcrByKey({ textItems, ocrRegions: ocr.regions });
        } catch (error) {
          ocrError = error instanceof Error ? error.message : String(error);
        }
      }

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

      if (process.env.NANOBANANA_3P_OCR_ENABLED !== "0") {
        try {
          const registration = await nanoBanana3pEstimateRegistration({
            imageA: { mimeType: genA.mimeType, base64: genA.base64 },
            imageB: { mimeType: genB.mimeType, base64: genB.base64 },
            canvas: { width, height },
            seedTag: `${seedTag}_reg`
          });
          registrationTransform = registration.transform;
          registrationLogId = registration.logId;
          registrationModel = registration.model;
          registrationRawText = registration.rawText;
        } catch (error) {
          registrationError = error instanceof Error ? error.message : String(error);
        }
      }

      registeredOcrRegions = transformOcrRegions({
        regions: ocrRegions,
        transform: registrationTransform,
        width,
        height
      });

      if (process.env.NANOBANANA_3P_OCR_ENABLED !== "0") {
        try {
          const boxResult = await nanoBanana3pExtractTextBoxes({
            image: { mimeType: genA.mimeType, base64: genA.base64 },
            canvas: { width, height },
            seedTag: `${seedTag}_text_boxes`
          });
          textBoxes = boxResult.boxes;
          textBoxLogId = boxResult.logId;
          textBoxModel = boxResult.model;
          textBoxRawText = boxResult.rawText;
        } catch (error) {
          textBoxError = error instanceof Error ? error.message : String(error);
        }
      }

      if (process.env.NANOBANANA_3P_OCR_ENABLED !== "0") {
        try {
          const diff = await nanoBanana3pExtractDiffCandidates({
            imageA: { mimeType: genA.mimeType, base64: genA.base64 },
            imageB: { mimeType: genB.mimeType, base64: genB.base64 },
            canvas: { width, height },
            seedTag: `${seedTag}_diff`
          });
          diffCandidates = diff.candidates;
          diffLogId = diff.logId;
          diffModel = diff.model;
          diffRawText = diff.rawText;
        } catch (error) {
          diffError = error instanceof Error ? error.message : String(error);
        }
      }
      registeredDiffCandidates = transformDiffCandidates({
        candidates: diffCandidates,
        transform: registrationTransform,
        width,
        height
      });

      registeredTextBoxes = transformTextBoxes({
        boxes: textBoxes,
        transform: registrationTransform,
        width,
        height
      });

      if (process.env.NANOBANANA_3P_STYLE_HINT_ENABLED !== "0" && (ocrRegionCount > 0 || diffCandidates.length > 0)) {
        try {
          const visual = await nanoBanana3pExtractVisualPlacementHints({
            imageA: { mimeType: genA.mimeType, base64: genA.base64 },
            imageB: { mimeType: genB.mimeType, base64: genB.base64 },
            canvas: { width, height },
            textItems: textItems.map((item) => ({ key: item.key, text: item.text })),
            ocrRegions,
            diffCandidates,
            seedTag: `${seedTag}_style`
          });
          styleHintLogId = visual.logId;
          styleHintModel = visual.model;
          styleHintPlacementRawText = visual.rawText;
          styleHintPlacementCount = visual.items.length;
          visualHints = visual.items;
        } catch (error) {
          styleHintError = error instanceof Error ? error.message : String(error);
        }
      }

      const fused = buildBlocksFromDiffDominant({
        textItems,
        fallbackBlocks,
        ocrRegions: registeredOcrRegions,
        diffCandidates: registeredDiffCandidates,
        textBoxes: registeredTextBoxes,
        visualHints,
        width,
        height
      });
      placementBlocks = fused.blocks;
      placementSource = fused.placementSource;
      placementSourceByKey = fused.sourceByKey;
      lineAnchorsByKey = fused.lineAnchorsByKey;
      ocrMatchedKeys = Object.entries(placementSourceByKey)
        .filter(([, source]) => source === "ocr" || source === "diff+ocr")
        .map(([key]) => key);
      ocrUsed = ocrMatchedKeys.length > 0;

      if (process.env.NANOBANANA_3P_STYLE_HINT_ENABLED !== "0") {
        try {
          const blockByKey = new Map(placementBlocks.map((block) => [block.key, block] as const));
          const regionHints = textItems.map((item) => {
            const ocrRegion = rawOcrMatchByKey.get(item.key);
            const block = blockByKey.get(item.key);
            return {
              key: item.key,
              x: ocrRegion?.region.x ?? block?.x ?? Math.round(width * 0.12),
              y: ocrRegion?.region.y ?? block?.y ?? Math.round(height * 0.12),
              w: ocrRegion?.region.w ?? block?.w ?? Math.round(width * 0.76),
              h: ocrRegion?.region.h ?? block?.h ?? Math.round(height * 0.08)
            };
          });
          const style = await nanoBanana3pExtractRegionStyleHints({
            image: { mimeType: genA.mimeType, base64: genA.base64 },
            canvas: { width, height },
            textItems: textItems.map((item) => ({ key: item.key, text: item.text })),
            regionHints,
            seedTag: `${seedTag}_region_style`
          });
          styleHintLogId = style.logId;
          styleHintModel = style.model;
          styleHintRawText = style.rawText;
          styleHintCount = style.styles.length;
          styleHintUsed = style.styles.length > 0;
          styleHintsByKey = Object.fromEntries(style.styles.map((item) => [item.key, item]));
        } catch (error) {
          if (!styleHintError) styleHintError = error instanceof Error ? error.message : String(error);
        }
      }
      if (!styleHintsByKey && visualHints.length > 0) {
        styleHintsByKey = Object.fromEntries(
          visualHints.map((item) => [
            item.key,
            {
              key: item.key,
              color: item.color,
              fontSize: item.fontSize,
              fontWeight: item.fontWeight,
              align: item.align
            }
          ])
        );
        styleHintUsed = true;
        styleHintCount = visualHints.length;
      }

      prompt = posterATextPrompt;
      negativePrompt = genB.negativePrompt;
      imageUrl = posterBUrl;
      editorBackgroundUrl = posterAUrl;
      layers = [
        buildGuideOverlayLayer({ width, height, src: posterBUrl }),
        ...buildTextLayers({
          width,
          height,
          textItems,
          layout: { blocks: placementBlocks },
          styleHints: styleHintsByKey,
          sourceByKey: placementSourceByKey,
          lineAnchorsByKey
        })
      ];
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
        referenceInjectionUsed,
        referenceInjectionLogId,
        referenceInjectionModel,
        referenceInjectionPrompt,
        referenceInjectionError,
        placementSource,
        placementSourceByKey,
        placementBlocks,
        placementLineAnchorsByKey: lineAnchorsByKey,
        placementFallbackBlocks: fallbackBlocks,
        ocrEnabled: process.env.NANOBANANA_3P_OCR_ENABLED !== "0",
        ocrUsed,
        ocrModel,
        ocrLogId,
        ocrRegionCount,
        ocrMatchedKeys,
        ocrError,
        ocrRawText,
        registeredOcrRegionCount: registeredOcrRegions.length,
        registeredOcrRegions,
        diffCandidateCount: diffCandidates.length,
        diffCandidates,
        registeredDiffCandidateCount: registeredDiffCandidates.length,
        registeredDiffCandidates,
        textBoxCount: textBoxes.length,
        textBoxes,
        registeredTextBoxCount: registeredTextBoxes.length,
        registeredTextBoxes,
        textBoxModel,
        textBoxLogId,
        textBoxError,
        textBoxRawText,
        diffModel,
        diffLogId,
        diffRawText,
        diffError,
        registrationEnabled: process.env.NANOBANANA_3P_OCR_ENABLED !== "0",
        registrationModel,
        registrationLogId,
        registrationTransform,
        registrationRawText,
        registrationError,
        styleHintEnabled: process.env.NANOBANANA_3P_STYLE_HINT_ENABLED !== "0",
        styleHintUsed,
        styleHintModel,
        styleHintLogId,
        styleHintCount,
        styleHintError,
        styleHintRawText,
        styleHintPlacementCount,
        styleHintPlacementRawText,
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
      layers = buildTextLayers({ width, height, textItems, layout: { blocks: fallbackBlocks } });
      params = {
        model: body.imageModel ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        imageModel: body.imageModel ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        seed,
        fallback: true,
        palette: fallback.palette,
        nanoBananaError,
        placementSource: "fallback",
        placementBlocks: fallbackBlocks,
        placementSourceByKey: Object.fromEntries(textItems.map((item) => [item.key, "fallback"])),
        ocrEnabled: process.env.NANOBANANA_3P_OCR_ENABLED !== "0",
        ocrUsed: false,
        ocrError,
        diffCandidateCount: 0,
        styleHintEnabled: process.env.NANOBANANA_3P_STYLE_HINT_ENABLED !== "0",
        styleHintUsed: false
      };
      provider = "FallbackSVG";
    }

    candidates.push({
      id,
      imageUrl,
      editorBackgroundUrl,
      layers,
      meta: { provider, prompt, negativePrompt, params }
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
