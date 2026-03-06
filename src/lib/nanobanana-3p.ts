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
        multimodal_contents: z
          .array(
            z.discriminatedUnion("type", [
              z.object({ type: z.literal("text"), text: z.string() }),
              z.object({
                type: z.literal("inline_data"),
                inline_data: z.object({
                  mime_type: z.string(),
                  data: z.string()
                })
              })
            ])
          )
          .optional()
      })
    })
  )
});

export async function nanoBanana3pGenerateImage({
  text,
  aspectRatio,
  imageSize = "1K",
  seedTag,
  thinking
}: {
  text: string;
  aspectRatio: string;
  imageSize?: "1K" | "2K";
  seedTag: string;
  thinking?: NanoBanana3pThinking;
}) {
  const normalizedThinking = normalizeThinking(thinking);
  const id = logId(seedTag);

  const baseBody = {
    stream: false,
    model: model(),
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "你是海报生成器。",
              "请在同一次回复里同时返回：",
              "1) 一段 JSON 文本（只包含 JSON，不要 Markdown 代码块），用于记录生成提示词；结构：",
              '{ "prompt": string, "negativePrompt": string, "params": object }',
              "2) 一张海报背景图片（PNG）。",
              "",
              "图片要求：无任何文字/字母/水印/Logo；预留顶部约 20% 的干净留白区域，方便后续叠加文字组件；禁止出现任何 UI 字样。",
              "JSON 要求：prompt 精准描述画面风格、构图、色彩、元素与留白；negativePrompt 必须显式禁止 text/logo/watermark/typography。",
              "",
              "主题含义：",
              text
            ].join("\n")
          }
        ]
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

    const attempt = async (includeThinking: boolean) => {
      const body = includeThinking && normalizedThinking ? { ...baseBody, thinking: normalizedThinking } : baseBody;
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-TT-LOGID": id },
        body: JSON.stringify(body)
      });
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, text };
    };

    const first = await attempt(true);
    const shouldRetryWithoutThinking =
      !first.ok && (first.text.includes("thinking is not supported") || first.text.includes("thinking") && first.status === 400);
    const final = shouldRetryWithoutThinking ? await attempt(false) : first;

    if (!final.ok) {
      lastErrs.push(`${base} HTTP ${final.status}: ${final.text}`);
      continue;
    }

    const json = MultimodalResponseSchema.parse(JSON.parse(final.text));
    const mm = json.choices[0]?.message?.multimodal_contents ?? [];
    const image = mm.find((c) => c.type === "inline_data") as
      | { type: "inline_data"; inline_data: { mime_type: string; data: string } }
      | undefined;
    const textParts = mm.filter((c) => c.type === "text").map((c) => (c as any).text as string);
    if (!image) throw new Error("NanoBanana response missing inline_data image");

    const joinedText = textParts.join("");
    const promptJson = safeParseJson(joinedText);
    const PromptSchema = z.object({
      prompt: z.string(),
      negativePrompt: z.string().optional(),
      params: z.record(z.unknown()).optional()
    });
    const validated = PromptSchema.parse(promptJson);

    return {
      logId: id,
      mimeType: image.inline_data.mime_type,
      base64: image.inline_data.data,
      rawText: joinedText,
      prompt: validated.prompt,
      negativePrompt: validated.negativePrompt ?? "text, letters, words, logo, watermark, typography",
      params: validated.params ?? {}
    };
  }
  throw new Error(lastErrs.join("\n\n"));
}

function safeParseJson(s: string) {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`NanoBanana text is not JSON: ${trimmed.slice(0, 200)}`);
  }
}
