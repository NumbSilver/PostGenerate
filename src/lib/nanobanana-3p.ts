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

function model() {
  return process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview";
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
    .map((p) => (p as any)?.type === "text" ? (p as any)?.text : null)
    .filter((t): t is string => typeof t === "string");
}

export async function nanoBanana3pGenerateImage({
  text,
  aspectRatio,
  imageSize = "1K",
  seedTag,
  includeNegative,
  referenceImage,
  referenceStyle,
  thinking
}: {
  text: string;
  aspectRatio: string;
  imageSize?: "1K" | "2K";
  seedTag: string;
  includeNegative: boolean;
  referenceImage?: { mimeType: string; base64: string };
  referenceStyle?: { palette?: string[] };
  thinking?: NanoBanana3pThinking;
}) {
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

  // Default to trying reference image if present. Some gateways may reject it; we fall back automatically.
  const allowImagePart = process.env.NANOBANANA_3P_ALLOW_IMAGE_PART !== "0";
  const referenceDataUri = referenceImage ? toDataUri(referenceImage) : undefined;
  const referenceVariants = referenceDataUri
    ? [
        // Variants observed in different gateway implementations.
        { label: "image_url(object,url)", part: { type: "image_url", image_url: { url: referenceDataUri } } },
        { label: "image(string,image_url)", part: { type: "image", image_url: referenceDataUri } },
        { label: "mage(string,image_url)", part: { type: "mage", image_url: referenceDataUri } }
      ]
    : [];

  const baseBody = {
    stream: false,
    model: model(),
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
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text };
    };

    const tryWithVariant = async (includeThinking: boolean) => {
      if (!referenceImageUsed || referenceVariants.length === 0) {
        referenceImageVariant = undefined;
        return attempt({ includeThinking, includeRefImage: false });
      }
      for (const v of referenceVariants) {
        referenceImageVariant = v.label;
        const res = await attempt({ includeThinking, includeRefImage: true, variant: v.part });
        // If the gateway rejects the variant, try next one.
        if (!res.ok && (res.text.includes("unsupport Part Type") || res.text.includes("\"code\":\"-1013\""))) continue;
        return res;
      }
      // All variants rejected.
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
      // Some responses sporadically return TEXT-only despite requesting IMAGE; retry once with IMAGE-only.
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
      // Meta is no longer forced to be returned in the multimodal response.
      prompt: text,
      negativePrompt: includeNegative ? "text, letters, words, logo, watermark, typography" : undefined,
      params: {
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

// NOTE: This gateway may return text-only or image-only; we intentionally do not
// parse TEXT as JSON to avoid reducing the probability of an IMAGE payload.
