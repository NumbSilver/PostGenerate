import { z } from "zod";

export type NanoBanana3pThinking = {
  include_thoughts?: boolean;
  budget_tokens?: number;
};

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

function model(modelOverride?: string) {
  return modelOverride ?? process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview";
}

function isQwenImageModel(name: string) {
  return name.trim().toLowerCase() === "qwen-image";
}

function isOpenAIImagesModel(name: string) {
  return name.trim().toLowerCase() === "gpt-image-1.5";
}

function logId(input?: string) {
  return input ?? process.env.NANOBANANA_3P_LOGID ?? `pg_${Math.random().toString(16).slice(2)}`;
}

const MultimodalResponseSchema = z.object({
  choices: z.array(
    z.object({
      finish_reason: z.string().optional(),
      message: z.object({
        role: z.string().optional(),
        content: z.string().optional(),
        multimodal_contents: z.array(z.any()).optional()
      })
    })
  )
});

function toDataUri(input: { mimeType: string; base64: string }) {
  const b64 = input.base64.trim();
  if (b64.startsWith("data:")) return b64;
  if (b64.startsWith("http://") || b64.startsWith("https://")) return b64;
  return `data:${input.mimeType};base64,${b64}`;
}

function fromDataUri(uri: string) {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mime_type: match[1] || "image/png",
    data: match[2] || ""
  };
}

function extFromMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("webp")) return "webp";
  return "bin";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function parseAspectRatio(aspectRatio: string) {
  const [a, b] = aspectRatio.split(":").map((n) => Number(n));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 1;
  return a / b;
}

function roundTo64(value: number) {
  return Math.max(256, Math.round(value / 64) * 64);
}

function qwenSize({
  width,
  height,
  aspectRatio,
  imageSize
}: {
  width?: number;
  height?: number;
  aspectRatio: string;
  imageSize: "1K" | "2K";
}) {
  const maxSide = imageSize === "2K" ? 2048 : 1024;
  let targetW = width && width > 0 ? width : 0;
  let targetH = height && height > 0 ? height : 0;

  if (!targetW || !targetH) {
    const ratio = parseAspectRatio(aspectRatio);
    if (ratio >= 1) {
      targetW = maxSide;
      targetH = Math.round(maxSide / ratio);
    } else {
      targetH = maxSide;
      targetW = Math.round(maxSide * ratio);
    }
  }

  const currentMax = Math.max(targetW, targetH);
  if (currentMax > maxSide) {
    const scale = maxSide / currentMax;
    targetW = Math.round(targetW * scale);
    targetH = Math.round(targetH * scale);
  }

  targetW = roundTo64(clamp(targetW, 256, maxSide));
  targetH = roundTo64(clamp(targetH, 256, maxSide));
  return `${targetW}*${targetH}`;
}

function openAIImageSize({
  width,
  height,
  aspectRatio,
  imageSize
}: {
  width?: number;
  height?: number;
  aspectRatio: string;
  imageSize: "1K" | "2K";
}) {
  const ratio = (() => {
    if (width && height && width > 0 && height > 0) return width / height;
    return parseAspectRatio(aspectRatio);
  })();
  if (ratio > 1.08) return imageSize === "2K" ? "1536x1024" : "1536x1024";
  if (ratio < 0.92) return imageSize === "2K" ? "1024x1536" : "1024x1536";
  return "1024x1024";
}

function extractInlineImage(multimodalContents: unknown[]) {
  for (const part of multimodalContents) {
    const maybe = part as any;
    const inline = maybe?.inline_data ?? maybe?.inlineData ?? maybe?.data;
    if (inline?.data && inline?.mime_type) return { mime_type: inline.mime_type as string, data: inline.data as string };
    if (maybe?.type === "inline_data" && maybe?.inline_data?.data && maybe?.inline_data?.mime_type) {
      return { mime_type: maybe.inline_data.mime_type as string, data: maybe.inline_data.data as string };
    }
  }
  return null;
}

function extractTextParts(multimodalContents: unknown[]) {
  return multimodalContents
    .map((part) => ((part as any)?.type === "text" ? (part as any)?.text : null))
    .filter((t): t is string => typeof t === "string");
}

async function fetchUrlAsBase64(url: string) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Image URL fetch failed ${resp.status}: ${url}`);
  const contentType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buf = Buffer.from(await resp.arrayBuffer());
  return { mime_type: contentType, data: buf.toString("base64") };
}

async function resolveUploadAsset(input: { mimeType: string; base64: string }) {
  const raw = input.base64.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const resp = await fetch(raw);
    if (!resp.ok) throw new Error(`Reference asset fetch failed ${resp.status}: ${raw}`);
    const mimeType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    return { mimeType, bytes: Buffer.from(await resp.arrayBuffer()) };
  }
  if (raw.startsWith("data:")) {
    const parsed = fromDataUri(raw);
    if (!parsed) throw new Error("Invalid data URI for reference asset");
    return { mimeType: parsed.mime_type, bytes: Buffer.from(parsed.data, "base64") };
  }
  return { mimeType: input.mimeType || "image/png", bytes: Buffer.from(raw, "base64") };
}

async function extractImageFromAnyResponse(json: any) {
  const mm = json?.choices?.[0]?.message?.multimodal_contents;
  if (Array.isArray(mm)) {
    const image = extractInlineImage(mm);
    if (image) return image;
  }

  const directB64 = [
    json?.b64_json,
    json?.base64,
    json?.image_base64,
    json?.result?.image_base64,
    json?.output?.image_base64
  ].find((v) => typeof v === "string" && v.length > 0);
  if (typeof directB64 === "string") {
    const data = fromDataUri(directB64);
    if (data) return data;
    return { mime_type: "image/png", data: directB64 };
  }

  const candidates: any[] = [
    json?.data?.[0],
    json?.images?.[0],
    json?.output?.images?.[0],
    json?.result?.images?.[0],
    json?.results?.[0],
    json?.output?.[0],
    json?.choices?.[0]?.message?.content?.[0]
  ].filter(Boolean);

  for (const candidate of candidates) {
    const b64 = [
      candidate?.b64_json,
      candidate?.base64,
      candidate?.image_base64,
      candidate?.imageBase64,
      candidate?.inline_data?.data
    ].find((v) => typeof v === "string" && v.length > 0);
    if (typeof b64 === "string") {
      const data = fromDataUri(b64);
      if (data) return data;
      const mimeType =
        candidate?.mime_type ?? candidate?.mimeType ?? candidate?.inline_data?.mime_type ?? candidate?.inlineData?.mimeType ?? "image/png";
      return { mime_type: mimeType, data: b64 };
    }

    const maybeUrl =
      candidate?.url ??
      candidate?.image_url?.url ??
      candidate?.image_url ??
      candidate?.imageUrl ??
      candidate?.output_url ??
      candidate?.uri;
    if (typeof maybeUrl === "string" && maybeUrl.length > 0) {
      if (maybeUrl.startsWith("data:")) {
        const data = fromDataUri(maybeUrl);
        if (data) return data;
      } else if (maybeUrl.startsWith("http://") || maybeUrl.startsWith("https://")) {
        return await fetchUrlAsBase64(maybeUrl);
      }
    }
  }

  return null;
}

export async function nanoBanana3pGenerateImage({
  text,
  aspectRatio,
  imageSize = "1K",
  seedTag,
  includeNegative,
  referenceImage,
  referenceStyle,
  thinking,
  width,
  height,
  modelOverride,
  referenceMask
}: {
  text: string;
  aspectRatio: string;
  imageSize?: "1K" | "2K";
  seedTag: string;
  includeNegative: boolean;
  referenceImage?: { mimeType: string; base64: string };
  referenceStyle?: { palette?: string[] };
  thinking?: NanoBanana3pThinking;
  width?: number;
  height?: number;
  modelOverride?: string;
  referenceMask?: { mimeType: string; base64: string };
}) {
  const selectedModel = model(modelOverride);
  const normalizedThinking = normalizeThinking(thinking);
  const id = logId(seedTag);

  const styleHint = referenceStyle?.palette?.length
    ? `参考图提取的配色（仅供风格参考）：${referenceStyle.palette.join(", ")}。请尽量使用类似的主色调、对比度与氛围。`
    : undefined;

  const constraint = includeNegative
    ? [
        "Image constraints: no text, no letters, no watermark, no logo.",
        "Leave the top ~20% clean/empty for later text overlay.",
        "Do not include UI elements or any typographic glyphs."
      ].join("\n")
    : [
        "Image constraints: text is allowed.",
        "Still leave the top ~20% relatively clean for a title area.",
        "Avoid obvious watermarks and brand logos."
      ].join("\n");

  const promptText = [constraint, styleHint ?? "", "", text].join("\n").trim();

  if (isOpenAIImagesModel(selectedModel)) {
    const errors: string[] = [];
    for (const base of baseUrls()) {
      const quality = process.env.NANOBANANA_3P_OPENAI_IMAGE_QUALITY ?? "low";
      const size = openAIImageSize({ width, height, aspectRatio, imageSize });
      const useEdits = Boolean(referenceImage);
      const url = new URL(
        useEdits ? "/gpt/openapi/online/v2/crawl/openai/images/edits" : "/gpt/openapi/online/v2/crawl/openai/images/generations",
        base
      );
      url.searchParams.set("ak", ak());
      try {
        let resp: Response;
        if (useEdits && referenceImage) {
          const imageAsset = await resolveUploadAsset(referenceImage);
          const form = new FormData();
          form.append(
            "image[]",
            new Blob([imageAsset.bytes], { type: imageAsset.mimeType }),
            `reference.${extFromMimeType(imageAsset.mimeType)}`
          );
          if (referenceMask) {
            const maskAsset = await resolveUploadAsset(referenceMask);
            form.append("mask", new Blob([maskAsset.bytes], { type: maskAsset.mimeType }), `mask.${extFromMimeType(maskAsset.mimeType)}`);
          }
          form.append("prompt", promptText);
          form.append("model", selectedModel);
          form.append("quality", quality);
          form.append("size", size);
          form.append("n", "1");
          resp = await fetch(url.toString(), {
            method: "POST",
            headers: { "X-TT-LOGID": id },
            body: form
          });
        } else {
          const body = {
            model: selectedModel,
            prompt: promptText,
            n: 1,
            size,
            quality
          };
          resp = await fetch(url.toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-TT-LOGID": id },
            body: JSON.stringify(body)
          });
        }
        const raw = await resp.text();
        if (!resp.ok) {
          errors.push(`${base} HTTP ${resp.status}: ${raw}`);
          continue;
        }
        const json = JSON.parse(raw);
        const image = await extractImageFromAnyResponse(json);
        if (!image) {
          errors.push(`${base} no image payload: ${raw.slice(0, 320)}`);
          continue;
        }
        return {
          logId: id,
          mimeType: image.mime_type,
          base64: image.data,
          rawText: "",
          prompt: text,
          negativePrompt: includeNegative ? "text, letters, words, logo, watermark, typography" : undefined,
          params: {
            apiMode: useEdits ? "openai-images-edits-v2" : "openai-images-v2",
            imageModel: selectedModel,
            size,
            quality,
            referenceImageUsed: useEdits,
            referenceMaskUsed: Boolean(referenceMask),
            referenceStyleUsed: Boolean(referenceStyle?.palette?.length),
            referencePalette: referenceStyle?.palette
          }
        };
      } catch (error) {
        errors.push(`${base} parse error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(errors.join("\n\n"));
  }

  if (isQwenImageModel(selectedModel)) {
    const errors: string[] = [];
    for (const base of baseUrls()) {
      const url = new URL("/gpt/openapi/online/multimodal/crawl", base);
      url.searchParams.set("ak", ak());
      const body = {
        model: selectedModel,
        input: {
          prompt: promptText
        },
        parameters: {
          size: qwenSize({ width, height, aspectRatio, imageSize }),
          n: 1
        }
      };
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TT-LOGID": id },
        body: JSON.stringify(body)
      });
      const raw = await resp.text();
      if (!resp.ok) {
        errors.push(`${base} HTTP ${resp.status}: ${raw}`);
        continue;
      }
      try {
        const json = JSON.parse(raw);
        const image = await extractImageFromAnyResponse(json);
        if (!image) {
          errors.push(`${base} no image payload: ${raw.slice(0, 320)}`);
          continue;
        }
        return {
          logId: id,
          mimeType: image.mime_type,
          base64: image.data,
          rawText: "",
          prompt: text,
          negativePrompt: includeNegative ? "text, letters, words, logo, watermark, typography" : undefined,
          params: {
            apiMode: "qwen-image",
            imageModel: selectedModel,
            size: body.parameters.size,
            referenceStyleUsed: Boolean(referenceStyle?.palette?.length),
            referencePalette: referenceStyle?.palette
          }
        };
      } catch (error) {
        errors.push(`${base} parse error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(errors.join("\n\n"));
  }

  const allowImagePart = process.env.NANOBANANA_3P_ALLOW_IMAGE_PART !== "0";
  const referenceDataUri = referenceImage ? toDataUri(referenceImage) : undefined;
  const referenceVariants = referenceDataUri
    ? [
        { label: "image_url(object,url)", part: { type: "image_url", image_url: { url: referenceDataUri } } },
        { label: "image(string,image_url)", part: { type: "image", image_url: referenceDataUri } },
        { label: "mage(string,image_url)", part: { type: "mage", image_url: referenceDataUri } }
      ]
    : [];

  const baseBody = {
    stream: false,
    model: selectedModel,
    max_tokens: 20000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "你是海报生成器。",
              "请生成一张海报背景 PNG 图片。",
              "请不要输出 JSON，不要输出代码块。",
              "文本输出（TEXT）可以为空或只输出一句话描述。",
              constraint,
              styleHint ? `\n${styleHint}\n` : "",
              "",
              "主题含义：",
              text
            ].join("\n")
          }
        ] as any[]
      }
    ],
    response_modalities: ["TEXT", "IMAGE"],
    image_config: {
      aspectRatio,
      imageSize,
      imageOutputOptions: { mimeType: "image/png" }
    }
  };

  const lastErrs: string[] = [];
  for (const base of baseUrls()) {
    const url = new URL("/gpt/openapi/online/multimodal/crawl", base);
    url.searchParams.set("ak", ak());

    let referenceImageUsed = Boolean(allowImagePart && referenceImage);
    let referenceImageIgnoredReason: string | undefined;
    let referenceImageVariant: string | undefined;
    const referenceStyleUsed = Boolean(referenceStyle?.palette?.length);

    const attempt = async (opts: { includeThinking: boolean; includeRefImage: boolean; imageOnly?: boolean; variant?: unknown }) => {
      const { includeThinking, includeRefImage, imageOnly, variant } = opts;
      const baseContent = baseBody.messages[0]!.content.slice(0, 1);
      const content = includeRefImage && variant ? (baseContent as any[]).concat([variant as any]) : baseContent;
      const messages = [{ ...baseBody.messages[0]!, content }];
      const body0 = {
        ...baseBody,
        messages: imageOnly
          ? [
              {
                ...messages[0]!,
                content: [
                  {
                    ...(messages[0]!.content[0] as any),
                    text: `${(messages[0]!.content[0] as any).text}\n\n只返回一张 PNG 图片（IMAGE），不要返回任何文字。`
                  },
                  ...messages[0]!.content.slice(1)
                ]
              }
            ]
          : messages,
        response_modalities: imageOnly ? ["IMAGE"] : baseBody.response_modalities,
        max_tokens: imageOnly ? 1024 : baseBody.max_tokens
      };
      const body = includeThinking && normalizedThinking ? { ...body0, thinking: normalizedThinking } : body0;
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TT-LOGID": id },
        body: JSON.stringify(body)
      });
      const textRaw = await resp.text();
      return { ok: resp.ok, status: resp.status, text: textRaw };
    };

    const tryWithVariant = async (includeThinking: boolean) => {
      if (!referenceImageUsed || referenceVariants.length === 0) {
        referenceImageVariant = undefined;
        return attempt({ includeThinking, includeRefImage: false });
      }
      for (const variant of referenceVariants) {
        referenceImageVariant = variant.label;
        const res = await attempt({ includeThinking, includeRefImage: true, variant: variant.part });
        if (!res.ok && (res.text.includes("unsupport Part Type") || res.text.includes("\"code\":\"-1013\""))) continue;
        return res;
      }
      referenceImageUsed = false;
      referenceImageVariant = undefined;
      referenceImageIgnoredReason = "gateway rejected all image part variants (dropped reference image)";
      return attempt({ includeThinking, includeRefImage: false });
    };

    let first = await tryWithVariant(true);
    const shouldRetryWithoutThinking =
      !first.ok && (first.text.includes("thinking is not supported") || first.text.includes("thinking") && first.status === 400);
    if (shouldRetryWithoutThinking) first = await tryWithVariant(false);
    const shouldDropRefImage =
      !first.ok &&
      referenceImage &&
      (first.text.includes("Provided image is not valid") ||
        first.text.includes("unsupport Part Type") ||
        first.text.includes("Part Type: image") ||
        first.text.includes("\"code\":\"-1013\""));
    if (shouldDropRefImage) {
      referenceImageUsed = false;
      referenceImageVariant = undefined;
      referenceImageIgnoredReason = "gateway does not support image parts (dropped reference image)";
      first = await attempt({ includeThinking: false, includeRefImage: false });
    }
    const final = first;

    if (!final.ok) {
      lastErrs.push(`${base} HTTP ${final.status}: ${final.text}`);
      continue;
    }

    const json = MultimodalResponseSchema.parse(JSON.parse(final.text));
    const message = json.choices[0]?.message;
    const mm = message?.multimodal_contents ?? [];
    const image = extractInlineImage(mm);
    const textParts = extractTextParts(mm);

    if (!image) {
      const retry = await attempt({ includeThinking: false, includeRefImage: Boolean(referenceImage), imageOnly: true });
      if (retry.ok) {
        const json2 = MultimodalResponseSchema.parse(JSON.parse(retry.text));
        const mm2 = json2.choices[0]?.message?.multimodal_contents ?? [];
        const image2 = extractInlineImage(mm2);
        const textParts2 = extractTextParts(mm2);
        if (image2) {
          return {
            logId: id,
            mimeType: image2.mime_type,
            base64: image2.data,
            rawText: textParts2.join(""),
            prompt: text,
            negativePrompt: includeNegative ? "text, letters, words, logo, watermark, typography" : undefined,
            params: {
              apiMode: "multimodal",
              imageModel: selectedModel,
              referenceImageUsed,
              referenceImageIgnoredReason,
              referenceImageVariant,
              referenceStyleUsed,
              referencePalette: referenceStyle?.palette
            }
          };
        }
      }
      const msgKeys = message ? Object.keys(message as any).join(", ") : "(no message)";
      const firstPart = mm[0] ? JSON.stringify(mm[0]).slice(0, 240) : "(empty multimodal_contents)";
      throw new Error(
        `NanoBanana response missing image payload. message keys: ${msgKeys} multimodal_contents length: ${mm.length} first part: ${firstPart} response snippet: ${final.text.slice(
          0,
          260
        )}`
      );
    }

    return {
      logId: id,
      mimeType: image.mime_type,
      base64: image.data,
      rawText: textParts.join(""),
      prompt: text,
      negativePrompt: includeNegative ? "text, letters, words, logo, watermark, typography" : undefined,
      params: {
        apiMode: "multimodal",
        imageModel: selectedModel,
        referenceImageUsed,
        referenceImageIgnoredReason,
        referenceImageVariant,
        referenceStyleUsed,
        referencePalette: referenceStyle?.palette
      }
    };
  }
  throw new Error(lastErrs.join("\n\n"));
}
