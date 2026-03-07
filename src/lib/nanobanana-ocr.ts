import { z } from "zod";

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

const JsonRegionSchema = z.object({
  text: z.string().optional(),
  raw: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  angle: z.number().optional()
});

const StylePanelSchema = z.object({
  enabled: z.boolean().optional(),
  fill: z.string().optional(),
  opacity: z.number().optional(),
  radius: z.number().optional(),
  paddingX: z.number().optional(),
  paddingY: z.number().optional()
});

const StyleItemSchema = z.object({
  key: z.string().min(1),
  color: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  panel: StylePanelSchema.optional()
});

const StyleResponseSchema = z.object({
  styles: z.array(StyleItemSchema)
});

export type OcrRegion = {
  text: string;
  raw: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
};

export type OcrExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  regions: OcrRegion[];
};

export type OcrPanelHint = {
  enabled: boolean;
  fill: string;
  opacity: number;
  radius: number;
  paddingX: number;
  paddingY: number;
};

export type OcrTextStyleHint = {
  key: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  panel?: OcrPanelHint;
};

export type OcrStyleExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  styles: OcrTextStyleHint[];
};

function baseUrls() {
  const preferred = process.env.NANOBANANA_3P_OCR_BASE_URL ?? "https://search.bytedance.net";
  const urls = [preferred];
  const fallback = process.env.NANOBANANA_3P_OCR_FALLBACK_BASE_URL ?? process.env.NANOBANANA_3P_FALLBACK_BASE_URL;
  if (fallback && !urls.includes(fallback)) urls.push(fallback);
  const imageBase = process.env.NANOBANANA_3P_BASE_URL;
  if (imageBase && !urls.includes(imageBase)) urls.push(imageBase);
  return urls;
}

function ak() {
  return process.env.NANOBANANA_3P_OCR_AK ?? process.env.NANOBANANA_3P_AK ?? "";
}

function model() {
  return process.env.NANOBANANA_3P_OCR_MODEL ?? "openai_qwen-vl-ocr-latest";
}

function maxTokens() {
  const raw = Number(process.env.NANOBANANA_3P_OCR_MAX_TOKENS ?? 1200);
  if (!Number.isFinite(raw) || raw <= 0) return 1200;
  return Math.floor(raw);
}

function rateLimitWaitMs() {
  const raw = Number(process.env.NANOBANANA_3P_OCR_RATE_LIMIT_WAIT_MS ?? 60000);
  if (!Number.isFinite(raw) || raw <= 0) return 60000;
  return Math.floor(raw);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function logId(seedTag?: string) {
  return seedTag ?? process.env.NANOBANANA_3P_LOGID ?? `pg_ocr_${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
    return null;
  }
}

function isHexColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) || /^#[0-9a-f]{3}$/i.test(value);
}

function toDataUri(input: { mimeType: string; base64: string }) {
  const base64 = input.base64.trim();
  if (base64.startsWith("data:")) return base64;
  return `data:${input.mimeType};base64,${base64}`;
}

function parseNumericToken(token: string) {
  const value = Number(token.trim());
  return Number.isFinite(value) ? value : null;
}

function parseRegionFromLine(line: string, canvas: { width: number; height: number }): OcrRegion | null {
  const raw = line.trim();
  if (!raw) return null;
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length < 5) return null;

  let numericCount = 0;
  while (numericCount < parts.length) {
    if (parseNumericToken(parts[numericCount] ?? "") === null) break;
    numericCount += 1;
  }
  if (numericCount < 4 || numericCount >= parts.length) return null;

  const text = parts.slice(numericCount).join(",").trim();
  if (!text) return null;

  const numbers = parts.slice(0, numericCount).map((part) => parseNumericToken(part) as number);
  let x = 0;
  let y = 0;
  let w = 0;
  let h = 0;
  let angle = 0;

  if (numbers.length >= 5) {
    const centerX = numbers[0]!;
    const centerY = numbers[1]!;
    const maybeH = Math.abs(numbers[2]!);
    const maybeW = Math.abs(numbers[3]!);
    angle = numbers[4] ?? 0;
    x = centerX - maybeW / 2;
    y = centerY - maybeH / 2;
    w = maybeW;
    h = maybeH;
  } else {
    const x1 = numbers[0]!;
    const y1 = numbers[1]!;
    const x2 = numbers[2]!;
    const y2 = numbers[3]!;
    x = Math.min(x1, x2);
    y = Math.min(y1, y2);
    w = Math.abs(x2 - x1);
    h = Math.abs(y2 - y1);
  }

  if (w < 6 || h < 6) return null;

  const safeX = clamp(Math.round(x), 0, Math.max(0, canvas.width - 6));
  const safeY = clamp(Math.round(y), 0, Math.max(0, canvas.height - 6));
  const safeW = clamp(Math.round(w), 6, Math.max(6, canvas.width - safeX));
  const safeH = clamp(Math.round(h), 6, Math.max(6, canvas.height - safeY));

  return {
    text,
    raw,
    x: safeX,
    y: safeY,
    w: safeW,
    h: safeH,
    angle
  };
}

function parseRegionsFromJsonObject(obj: unknown, canvas: { width: number; height: number }) {
  const records = Array.isArray((obj as any)?.regions) ? ((obj as any).regions as unknown[]) : [];
  const regions: OcrRegion[] = [];
  for (const regionInput of records) {
    const parsed = JsonRegionSchema.safeParse(regionInput);
    if (!parsed.success) continue;
    const region = parsed.data;
    const text = (region.text ?? "").trim();
    if (!text) continue;

    if (region.raw?.trim()) {
      const fromRaw = parseRegionFromLine(region.raw, canvas);
      if (fromRaw) {
        regions.push({ ...fromRaw, text });
        continue;
      }
    }

    const x = region.x;
    const y = region.y;
    const w = region.w ?? region.width;
    const h = region.h ?? region.height;
    if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number") continue;
    if (w < 6 || h < 6) continue;

    const safeX = clamp(Math.round(x), 0, Math.max(0, canvas.width - 6));
    const safeY = clamp(Math.round(y), 0, Math.max(0, canvas.height - 6));
    const safeW = clamp(Math.round(w), 6, Math.max(6, canvas.width - safeX));
    const safeH = clamp(Math.round(h), 6, Math.max(6, canvas.height - safeY));
    regions.push({
      text,
      raw: region.raw ?? `${safeX},${safeY},${safeW},${safeH},${region.angle ?? 0},${text}`,
      x: safeX,
      y: safeY,
      w: safeW,
      h: safeH,
      angle: region.angle ?? 0
    });
  }
  return regions;
}

function parseOcrRegions(payload: string, canvas: { width: number; height: number }) {
  const regions: OcrRegion[] = [];
  const jsonObj = parseLooseJsonObject(payload);
  if (jsonObj) regions.push(...parseRegionsFromJsonObject(jsonObj, canvas));
  if (regions.length > 0) return regions;

  for (const line of payload.split("\n")) {
    const region = parseRegionFromLine(line, canvas);
    if (region) regions.push(region);
  }
  return regions;
}

function dedupeRegions(input: OcrRegion[]) {
  const seen = new Set<string>();
  const output: OcrRegion[] = [];
  for (const region of input) {
    const key = `${region.text}_${region.x}_${region.y}_${region.w}_${region.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(region);
  }
  return output.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

async function requestVisionPayload({
  id,
  textPrompt,
  images
}: {
  id: string;
  textPrompt: string;
  images: Array<{ mimeType: string; base64: string }>;
}) {
  const requestBody = {
    stream: false,
    model: model(),
    max_tokens: maxTokens(),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: textPrompt },
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: toDataUri(image) }
          }))
        ]
      }
    ]
  };

  const errors: string[] = [];
  for (const base of baseUrls()) {
    const url = new URL("/gpt/openapi/online/multimodal/crawl", base);
    url.searchParams.set("ak", ak());

    for (let attempt = 1; attempt <= 2; attempt++) {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TT-LOGID": id
        },
        body: JSON.stringify(requestBody)
      });
      const raw = await resp.text();

      if (resp.status === 429 && attempt === 1) {
        const waitMs = rateLimitWaitMs();
        await sleep(waitMs);
        continue;
      }

      if (!resp.ok) {
        errors.push(`${base} HTTP ${resp.status}: ${raw}`);
        break;
      }

      try {
        const parsed = ResponseSchema.parse(JSON.parse(raw));
        const message = parsed.choices[0]?.message;
        const payload = [message?.content ?? "", ...extractTextParts(message?.multimodal_contents ?? [])]
          .join("\n")
          .trim();
        return payload;
      } catch (error) {
        errors.push(`${base} parse error: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }

  throw new Error(errors.join("\n\n"));
}

export async function nanoBanana3pExtractOcrRegions({
  image,
  canvas,
  seedTag
}: {
  image: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  seedTag?: string;
}): Promise<OcrExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);
  const payload = await requestVisionPayload({
    id,
    textPrompt: [
      "你是 OCR 引擎。",
      "请识别图片中可见文字，并输出每个文本区域的位置。",
      "只输出纯文本，每行一个区域，格式固定为：x,y,h,w,angle,text",
      "不要输出任何解释、markdown 或额外标题。"
    ].join("\n"),
    images: [image]
  });
  const regions = dedupeRegions(parseOcrRegions(payload, canvas));
  return {
    logId: id,
    model: model(),
    rawText: payload,
    regions
  };
}

export async function nanoBanana3pExtractTextStyleHints({
  imageA,
  imageB,
  textItems,
  ocrRegions,
  seedTag
}: {
  imageA: { mimeType: string; base64: string };
  imageB: { mimeType: string; base64: string };
  textItems: Array<{ key: string; text: string }>;
  ocrRegions: OcrRegion[];
  seedTag?: string;
}): Promise<OcrStyleExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);

  const textPrompt = [
    "你是海报文字样式分析器。",
    "图1是海报A（有文字），图2是海报B（去文字后背景）。",
    "请为文案清单中的每个 key 输出重绘样式。",
    "仅输出 JSON，不要 markdown，不要解释。",
    "JSON格式：",
    "{\"styles\":[{\"key\":\"title\",\"color\":\"#FFFFFF\",\"fontSize\":72,\"fontWeight\":800,\"align\":\"left\",\"panel\":{\"enabled\":false,\"fill\":\"#000000\",\"opacity\":0.35,\"radius\":16,\"paddingX\":16,\"paddingY\":10}}]}",
    "约束：",
    "1) key 必须来自文案清单。",
    "2) color 必须是十六进制颜色。",
    "3) fontSize 12-240，fontWeight 400-900，align 仅 left/center/right。",
    "4) panel.enabled=true 仅在图2对应区域背景复杂、对比不足时。",
    "5) panel.fill 必须十六进制；opacity 0-0.75；radius 0-60；paddingX/paddingY 0-80。",
    "",
    "文案清单：",
    ...textItems.map((item) => `- ${item.key}: ${item.text}`),
    "",
    "OCR 区域（来自图1，仅供定位参考）：",
    ...(ocrRegions.length
      ? ocrRegions.map((region) => `- ${region.raw}`)
      : ["- (empty)"])
  ].join("\n");

  const payload = await requestVisionPayload({
    id,
    textPrompt,
    images: [imageA, imageB]
  });

  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Style JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = StyleResponseSchema.parse(jsonObj);

  const validKeys = new Set(textItems.map((item) => item.key));
  const styles: OcrTextStyleHint[] = [];
  for (const style of parsed.styles) {
    if (!validKeys.has(style.key)) continue;
    const color = style.color && isHexColor(style.color) ? style.color : undefined;
    const fontSize = typeof style.fontSize === "number" ? clamp(Math.round(style.fontSize), 12, 240) : undefined;
    const fontWeight = typeof style.fontWeight === "number" ? clamp(Math.round(style.fontWeight), 400, 900) : undefined;
    const align = style.align;
    const panelInput = style.panel;
    const panel =
      panelInput && panelInput.enabled
        ? {
            enabled: true,
            fill: isHexColor(panelInput.fill ?? "") ? (panelInput.fill as string) : "#000000",
            opacity: clamp(typeof panelInput.opacity === "number" ? panelInput.opacity : 0.35, 0, 0.75),
            radius: clamp(Math.round(panelInput.radius ?? 16), 0, 60),
            paddingX: clamp(Math.round(panelInput.paddingX ?? 16), 0, 80),
            paddingY: clamp(Math.round(panelInput.paddingY ?? 10), 0, 80)
          }
        : {
            enabled: false,
            fill: "#000000",
            opacity: 0,
            radius: 0,
            paddingX: 0,
            paddingY: 0
          };

    styles.push({
      key: style.key,
      color,
      fontSize,
      fontWeight,
      align,
      panel
    });
  }

  return {
    logId: id,
    model: model(),
    rawText: payload,
    styles
  };
}
