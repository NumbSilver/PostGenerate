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

const StyleItemSchema = z.object({
  key: z.string().min(1),
  color: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  fontFamily: z.enum(["sans", "serif", "cursive", "monospace"]).optional()
});

const StyleResponseSchema = z.object({
  styles: z.array(StyleItemSchema)
});

const DiffCandidateSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  score: z.number().optional(),
  reason: z.string().optional()
});

const DiffResponseSchema = z.object({
  candidates: z.array(DiffCandidateSchema)
});

const RegistrationResponseSchema = z.object({
  transform: z
    .object({
      dx: z.number().optional(),
      dy: z.number().optional(),
      tx: z.number().optional(),
      ty: z.number().optional(),
      scaleX: z.number().optional(),
      scaleY: z.number().optional(),
      scale: z.number().optional(),
      rotation: z.number().optional(),
      confidence: z.number().optional()
    })
    .optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  tx: z.number().optional(),
  ty: z.number().optional(),
  scaleX: z.number().optional(),
  scaleY: z.number().optional(),
  scale: z.number().optional(),
  rotation: z.number().optional(),
  confidence: z.number().optional()
});

const PlacementLineSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  angle: z.number().optional(),
  confidence: z.number().optional()
});

const PlacementItemSchema = z.object({
  key: z.string().min(1),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  angle: z.number().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.number().optional(),
  color: z.string().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  confidence: z.number().optional(),
  lines: z.array(PlacementLineSchema).optional()
});

const PlacementResponseSchema = z.object({
  items: z.array(PlacementItemSchema)
});

const TextBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  angle: z.number().optional(),
  score: z.number().optional()
});

const TextBoxResponseSchema = z.object({
  boxes: z.array(TextBoxSchema)
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

export type OcrTextStyleHint = {
  key: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  fontFamily?: "sans" | "serif" | "cursive" | "monospace";
};

export type OcrStyleExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  styles: OcrTextStyleHint[];
};

export type VisionDiffCandidate = {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  reason?: string;
};

export type VisionDiffExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  candidates: VisionDiffCandidate[];
};

export type VisionRegistrationTransform = {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  confidence: number;
};

export type VisionRegistrationExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  transform: VisionRegistrationTransform;
};

export type VisualLineHint = {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  confidence: number;
};

export type VisualPlacementHint = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  align?: "left" | "center" | "right";
  confidence: number;
  lines: VisualLineHint[];
};

export type VisualPlacementExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  items: VisualPlacementHint[];
};

export type VisionTextBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  score: number;
};

export type VisionTextBoxExtractResult = {
  logId: string;
  model: string;
  rawText: string;
  boxes: VisionTextBox[];
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

function visionModel() {
  return process.env.NANOBANANA_3P_VISION_MODEL ?? model();
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

function sanitizeDiffCandidates(input: Array<z.infer<typeof DiffCandidateSchema>>, canvas: { width: number; height: number }) {
  const candidates: VisionDiffCandidate[] = [];
  for (const item of input) {
    const x = clamp(Math.round(item.x), 0, Math.max(0, canvas.width - 8));
    const y = clamp(Math.round(item.y), 0, Math.max(0, canvas.height - 8));
    const w = clamp(Math.round(item.w), 8, Math.max(8, canvas.width - x));
    const h = clamp(Math.round(item.h), 8, Math.max(8, canvas.height - y));
    if (w < 8 || h < 8) continue;
    candidates.push({
      x,
      y,
      w,
      h,
      score: clamp(typeof item.score === "number" ? item.score : 0.8, 0, 1),
      reason: item.reason
    });
  }

  const dedup = new Map<string, VisionDiffCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.x}_${candidate.y}_${candidate.w}_${candidate.h}`;
    if (!dedup.has(key)) dedup.set(key, candidate);
  }
  return [...dedup.values()].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

function sanitizePlacementItems(
  input: Array<z.infer<typeof PlacementItemSchema>>,
  canvas: { width: number; height: number },
  validKeys: Set<string>
) {
  const items: VisualPlacementHint[] = [];
  for (const item of input) {
    if (!validKeys.has(item.key)) continue;
    const x = clamp(Math.round(item.x), 0, Math.max(0, canvas.width - 8));
    const y = clamp(Math.round(item.y), 0, Math.max(0, canvas.height - 8));
    const w = clamp(Math.round(item.w), 8, Math.max(8, canvas.width - x));
    const h = clamp(Math.round(item.h), 8, Math.max(8, canvas.height - y));
    const color = item.color && isHexColor(item.color) ? item.color : undefined;
    const fontSize = typeof item.fontSize === "number" ? clamp(Math.round(item.fontSize), 12, 240) : undefined;
    const fontWeight = typeof item.fontWeight === "number" ? clamp(Math.round(item.fontWeight), 400, 900) : undefined;
    const confidence = clamp(typeof item.confidence === "number" ? item.confidence : 0.65, 0, 1);
    const angle = clamp(typeof item.angle === "number" ? item.angle : 0, -45, 45);
    const lines: VisualLineHint[] = (item.lines ?? [])
      .map((line) => {
        const lx = clamp(Math.round(line.x), 0, Math.max(0, canvas.width - 8));
        const ly = clamp(Math.round(line.y), 0, Math.max(0, canvas.height - 8));
        const lw = clamp(Math.round(line.w), 8, Math.max(8, canvas.width - lx));
        const lh = clamp(Math.round(line.h), 8, Math.max(8, canvas.height - ly));
        return {
          x: lx,
          y: ly,
          w: lw,
          h: lh,
          angle: clamp(typeof line.angle === "number" ? line.angle : angle, -45, 45),
          confidence: clamp(typeof line.confidence === "number" ? line.confidence : confidence, 0, 1)
        };
      })
      .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
    items.push({
      key: item.key,
      x,
      y,
      w,
      h,
      angle,
      fontSize,
      fontWeight,
      color,
      align: item.align,
      confidence,
      lines
    });
  }

  const byKey = new Map<string, VisualPlacementHint>();
  for (const item of items) {
    const existing = byKey.get(item.key);
    if (!existing || item.confidence > existing.confidence) byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

function sanitizeTextBoxes(input: Array<z.infer<typeof TextBoxSchema>>, canvas: { width: number; height: number }) {
  const boxes: VisionTextBox[] = [];
  for (const item of input) {
    const x = clamp(Math.round(item.x), 0, Math.max(0, canvas.width - 8));
    const y = clamp(Math.round(item.y), 0, Math.max(0, canvas.height - 8));
    const w = clamp(Math.round(item.w), 8, Math.max(8, canvas.width - x));
    const h = clamp(Math.round(item.h), 8, Math.max(8, canvas.height - y));
    const score = clamp(typeof item.score === "number" ? item.score : 0.6, 0, 1);
    const angle = clamp(typeof item.angle === "number" ? item.angle : 0, -45, 45);
    if (w < 8 || h < 8) continue;
    boxes.push({ x, y, w, h, angle, score });
  }

  const dedup: VisionTextBox[] = [];
  for (const box of boxes.sort((a, b) => b.score - a.score)) {
    const overlap = dedup.some((existing) => {
      const x1 = Math.max(existing.x, box.x);
      const y1 = Math.max(existing.y, box.y);
      const x2 = Math.min(existing.x + existing.w, box.x + box.w);
      const y2 = Math.min(existing.y + existing.h, box.y + box.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const union = existing.w * existing.h + box.w * box.h - inter;
      return union > 0 && inter / union > 0.65;
    });
    if (!overlap) dedup.push(box);
  }
  return dedup.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
}

function sanitizeStyles(input: Array<z.infer<typeof StyleItemSchema>>, validKeys: Set<string>) {
  const styles: OcrTextStyleHint[] = [];
  for (const style of input) {
    if (!validKeys.has(style.key)) continue;
    const color = style.color && isHexColor(style.color) ? style.color : undefined;
    const fontSize = typeof style.fontSize === "number" ? clamp(Math.round(style.fontSize), 12, 240) : undefined;
    const fontWeight = typeof style.fontWeight === "number" ? clamp(Math.round(style.fontWeight), 400, 900) : undefined;
    styles.push({
      key: style.key,
      color,
      fontSize,
      fontWeight,
      align: style.align,
      fontFamily: style.fontFamily
    });
  }
  return styles;
}

function sanitizeRegistrationTransform(payload: z.infer<typeof RegistrationResponseSchema>, canvas: { width: number; height: number }) {
  const src = payload.transform ?? payload;
  const dx = src.dx ?? src.tx ?? 0;
  const dy = src.dy ?? src.ty ?? 0;
  const baseScale = src.scale ?? 1;
  const scaleX = src.scaleX ?? baseScale;
  const scaleY = src.scaleY ?? baseScale;
  const rotation = src.rotation ?? 0;
  const confidence = src.confidence ?? 0.65;
  const maxDx = canvas.width * 0.22;
  const maxDy = canvas.height * 0.22;

  return {
    dx: clamp(dx, -maxDx, maxDx),
    dy: clamp(dy, -maxDy, maxDy),
    scaleX: clamp(scaleX, 0.82, 1.18),
    scaleY: clamp(scaleY, 0.82, 1.18),
    rotation: clamp(rotation, -18, 18),
    confidence: clamp(confidence, 0, 1)
  };
}

async function requestVisionPayload({
  id,
  textPrompt,
  images,
  modelName
}: {
  id: string;
  textPrompt: string;
  images: Array<{ mimeType: string; base64: string }>;
  modelName?: string;
}) {
  const requestBody = {
    stream: false,
    model: modelName ?? model(),
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

export async function nanoBanana3pExtractDiffCandidates({
  imageA,
  imageB,
  canvas,
  seedTag
}: {
  imageA: { mimeType: string; base64: string };
  imageB: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  seedTag?: string;
}): Promise<VisionDiffExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);
  const payload = await requestVisionPayload({
    id,
    modelName: visionModel(),
    textPrompt: [
      "你是图像差分定位器。",
      "图1是海报A（有文字），图2是海报B（去文字）。",
      "请找出图1中存在但图2被删除的文字区域候选框。",
      "只输出 JSON，不要 markdown。",
      "格式：{\"candidates\":[{\"x\":100,\"y\":100,\"w\":300,\"h\":80,\"score\":0.9,\"reason\":\"title\"}]}"
    ].join("\n"),
    images: [imageA, imageB]
  });

  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Diff JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = DiffResponseSchema.parse(jsonObj);
  return {
    logId: id,
    model: visionModel(),
    rawText: payload,
    candidates: sanitizeDiffCandidates(parsed.candidates, canvas)
  };
}

export async function nanoBanana3pEstimateRegistration({
  imageA,
  imageB,
  canvas,
  seedTag
}: {
  imageA: { mimeType: string; base64: string };
  imageB: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  seedTag?: string;
}): Promise<VisionRegistrationExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);
  const payload = await requestVisionPayload({
    id,
    modelName: visionModel(),
    textPrompt: [
      "你是海报图像配准器。",
      "图1是海报A（有文字），图2是海报B（去文字）。",
      "请估计把图1坐标映射到图2坐标的全局变换。",
      "仅输出 JSON，不要 markdown。",
      "格式：{\"transform\":{\"dx\":0,\"dy\":0,\"scaleX\":1,\"scaleY\":1,\"rotation\":0,\"confidence\":0.9}}",
      "说明：dx/dy 为像素平移；scaleX/scaleY 为缩放；rotation 为度数（顺时针为正）；confidence 0-1。"
    ].join("\n"),
    images: [imageA, imageB]
  });
  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Registration JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = RegistrationResponseSchema.parse(jsonObj);
  return {
    logId: id,
    model: visionModel(),
    rawText: payload,
    transform: sanitizeRegistrationTransform(parsed, canvas)
  };
}

export async function nanoBanana3pExtractVisualPlacementHints({
  imageA,
  imageB,
  canvas,
  textItems,
  ocrRegions,
  diffCandidates,
  seedTag
}: {
  imageA: { mimeType: string; base64: string };
  imageB: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  textItems: Array<{ key: string; text: string }>;
  ocrRegions: OcrRegion[];
  diffCandidates: VisionDiffCandidate[];
  seedTag?: string;
}): Promise<VisualPlacementExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);
  const payload = await requestVisionPayload({
    id,
    modelName: visionModel(),
    textPrompt: [
      "你是海报文字位置与样式重建器。",
      "图1是海报A（有文字），图2是海报B（去文字）。",
      "请为文案清单中的每个 key 预测最终重绘信息（位置和样式）。",
      "只输出 JSON，不要 markdown。",
      "格式：{\"items\":[{\"key\":\"title\",\"x\":100,\"y\":120,\"w\":480,\"h\":120,\"fontSize\":78,\"fontWeight\":800,\"color\":\"#FFFFFF\",\"align\":\"center\",\"confidence\":0.92}]}",
      "约束：",
      "1) key 必须来自文案清单；",
      "2) color 必须十六进制；",
      "3) align 仅 left/center/right；",
      "4) 坐标必须在画布内。",
      "",
      `画布：${canvas.width}x${canvas.height}`,
      "文案清单：",
      ...textItems.map((item) => `- ${item.key}: ${item.text}`),
      "",
      "OCR区域参考（图1）：",
      ...(ocrRegions.length ? ocrRegions.map((region) => `- ${region.raw}`) : ["- (empty)"]),
      "",
      "差分候选框参考（图1-图2）：",
      ...(diffCandidates.length
        ? diffCandidates.map((box) => `- x=${box.x},y=${box.y},w=${box.w},h=${box.h},score=${box.score}`)
        : ["- (empty)"])
    ].join("\n"),
    images: [imageA, imageB]
  });

  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Placement JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = PlacementResponseSchema.parse(jsonObj);
  const validKeys = new Set(textItems.map((item) => item.key));
  return {
    logId: id,
    model: visionModel(),
    rawText: payload,
    items: sanitizePlacementItems(parsed.items, canvas, validKeys)
  };
}

export async function nanoBanana3pExtractTextBoxes({
  image,
  canvas,
  seedTag
}: {
  image: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  seedTag?: string;
}): Promise<VisionTextBoxExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);
  const payload = await requestVisionPayload({
    id,
    modelName: visionModel(),
    textPrompt: [
      "你是文本区域检测器。",
      "请检测图片中所有文字/字母/数字区域（即便无法识别内容也要框）。",
      "只输出 JSON，不要 markdown。",
      "格式：{\"boxes\":[{\"x\":100,\"y\":120,\"w\":400,\"h\":80,\"angle\":0,\"score\":0.9}]}",
      "约束：x/y/w/h 必须是像素，框必须在画布内。"
    ].join("\n"),
    images: [image]
  });

  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Text box JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = TextBoxResponseSchema.parse(jsonObj);
  return {
    logId: id,
    model: visionModel(),
    rawText: payload,
    boxes: sanitizeTextBoxes(parsed.boxes, canvas)
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
    "{\"styles\":[{\"key\":\"title\",\"color\":\"#FFFFFF\",\"fontSize\":72,\"fontWeight\":800,\"align\":\"left\"}]}",
    "约束：",
    "1) key 必须来自文案清单。",
    "2) color 必须是十六进制颜色。",
    "3) fontSize 12-240，fontWeight 400-900，align 仅 left/center/right。",
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
  const styles = sanitizeStyles(parsed.styles, validKeys);

  return {
    logId: id,
    model: model(),
    rawText: payload,
    styles
  };
}

export async function nanoBanana3pExtractRegionStyleHints({
  image,
  canvas,
  textItems,
  regionHints,
  seedTag
}: {
  image: { mimeType: string; base64: string };
  canvas: { width: number; height: number };
  textItems: Array<{ key: string; text: string }>;
  regionHints: Array<{ key: string; x: number; y: number; w: number; h: number }>;
  seedTag?: string;
}): Promise<OcrStyleExtractResult> {
  if (!ak()) throw new Error("Missing env NANOBANANA_3P_AK (or NANOBANANA_3P_OCR_AK)");
  const id = logId(seedTag);

  const textPrompt = [
    "你是海报文字样式分析器。",
    "请根据图中的指定区域，估计每条文案的视觉样式。",
    "仅输出 JSON，不要 markdown，不要解释。",
    "必须为每个 key 返回一条 style。",
    "JSON格式：",
    "{\"styles\":[{\"key\":\"title\",\"color\":\"#7AA35D\",\"fontSize\":84,\"fontWeight\":700,\"align\":\"center\",\"fontFamily\":\"cursive\"}]}",
    "约束：",
    "1) key 必须来自文案清单，且每个 key 必须出现一次；",
    "2) color 必须是十六进制颜色；",
    "3) fontSize 12-240，fontWeight 400-900，align 仅 left/center/right；",
    "4) fontFamily 只能是 sans/serif/cursive/monospace。",
    "5) 如果字形是连笔、书法、手写感，必须选 cursive；如果是印刷体且有衬线，选 serif。",
    "",
    `画布：${canvas.width}x${canvas.height}`,
    "文案清单：",
    ...textItems.map((item) => `- ${item.key}: ${item.text}`),
    "",
    "区域提示（图中坐标，x,y,w,h）：",
    ...regionHints.map((item) => `- ${item.key}: ${item.x},${item.y},${item.w},${item.h}`)
  ].join("\n");

  const payload = await requestVisionPayload({
    id,
    modelName: visionModel(),
    textPrompt,
    images: [image]
  });

  const jsonObj = parseLooseJsonObject(payload);
  if (!jsonObj) throw new Error(`Region style JSON parse failed: ${payload.slice(0, 220)}`);
  const parsed = StyleResponseSchema.parse(jsonObj);
  const validKeys = new Set(textItems.map((item) => item.key));
  return {
    logId: id,
    model: visionModel(),
    rawText: payload,
    styles: sanitizeStyles(parsed.styles, validKeys)
  };
}
