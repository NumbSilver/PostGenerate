import { z } from "zod";

export const TEXT_LINE_HEIGHT = 1.2;

const CjkCharPattern = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const PunctPattern = /[.,;:!?'"`~^*()[\]{}<>\-_=+\\/|]/;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function estimateCharWidth(char: string, fontSize: number) {
  if (char === " ") return fontSize * 0.33;
  if (char === "\t") return fontSize * 0.66;
  if (CjkCharPattern.test(char)) return fontSize * 0.98;
  if (/[A-Z]/.test(char)) return fontSize * 0.62;
  if (/[a-z]/.test(char)) return fontSize * 0.56;
  if (/[0-9]/.test(char)) return fontSize * 0.58;
  if (PunctPattern.test(char)) return fontSize * 0.38;
  return fontSize * 0.6;
}

function estimateTextWidth(text: string, fontSize: number) {
  let width = 0;
  for (const char of text) width += estimateCharWidth(char, fontSize);
  return width;
}

function wrapLineByWidth(text: string, maxWidth: number, fontSize: number) {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\r") continue;
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }

    const next = `${current}${char}`;
    if (!current || estimateTextWidth(next, fontSize) <= maxWidth) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  lines.push(current);
  return lines;
}

function wrapTextByWidth(text: string, maxWidth: number, fontSize: number) {
  return wrapLineByWidth(text, maxWidth, fontSize);
}

const FitInputSchema = z.object({
  text: z.string(),
  box: z.object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number()
  }),
  align: z.union([z.literal("left"), z.literal("center"), z.literal("right")]),
  fontSize: z.number(),
  minFontSize: z.number().optional(),
  maxFontSize: z.number().optional(),
  lineHeight: z.number().optional(),
  paddingX: z.number().optional(),
  paddingY: z.number().optional()
});

export function fitTextInBox(input: z.infer<typeof FitInputSchema>) {
  const parsed = FitInputSchema.parse(input);
  const lineHeight = parsed.lineHeight ?? TEXT_LINE_HEIGHT;
  const paddingX = parsed.paddingX ?? Math.max(8, Math.round(parsed.box.w * 0.04));
  const paddingY = parsed.paddingY ?? Math.max(6, Math.round(parsed.box.h * 0.1));

  const safeX = Math.round(parsed.box.x);
  const safeY = Math.round(parsed.box.y);
  const safeW = Math.max(20, Math.round(parsed.box.w));
  const safeH = Math.max(20, Math.round(parsed.box.h));

  const availableWidth = Math.max(20, safeW - paddingX * 2);
  const availableHeight = Math.max(20, safeH - paddingY * 2);
  const minFontSize = parsed.minFontSize ?? 12;
  const maxFontSize = parsed.maxFontSize ?? Math.max(minFontSize, Math.round(parsed.fontSize));

  let fontSize = clamp(Math.round(parsed.fontSize), minFontSize, maxFontSize);
  let lines = wrapTextByWidth(parsed.text, availableWidth, fontSize);

  while (fontSize > minFontSize) {
    const textHeight = lines.length * fontSize * lineHeight;
    if (textHeight <= availableHeight) break;
    fontSize -= 1;
    lines = wrapTextByWidth(parsed.text, availableWidth, fontSize);
  }

  if (fontSize === minFontSize) {
    const maxLines = Math.max(1, Math.floor(availableHeight / (fontSize * lineHeight)));
    if (lines.length > maxLines) {
      const mergedTail = lines.slice(maxLines - 1).join("");
      lines = [...lines.slice(0, maxLines - 1), mergedTail];
    }
  }

  const text = lines.join("\n");
  const textHeight = Math.max(1, Math.ceil(lines.length * fontSize * lineHeight));
  const finalY = Math.round(safeY + paddingY + Math.max(0, (availableHeight - textHeight) / 2));

  return {
    text,
    x: safeX + paddingX,
    y: finalY,
    w: availableWidth,
    h: Math.max(20, Math.min(availableHeight, textHeight)),
    fontSize,
    align: parsed.align,
    lineHeight
  };
}
