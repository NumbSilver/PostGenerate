import { z } from "zod";

const NanoBananaSvgResponseSchema = z.object({
  svg: z.string(),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  params: z.record(z.any()).optional()
});

export type NanoBananaThinking = {
  include_thoughts?: boolean;
  budget_tokens?: number;
};

export type NanoBananaGenerateSvgInput = {
  text: string;
  width: number;
  height: number;
  seed: number;
  thinking?: NanoBananaThinking;
  logId?: string;
};

function normalizeThinking(thinking?: NanoBananaThinking) {
  if (!thinking) {
    return { include_thoughts: true, budget_tokens: 8192 };
  }
  const budget = thinking.budget_tokens;
  if (budget === 0) return { include_thoughts: Boolean(thinking.include_thoughts), budget_tokens: 0 };
  if (typeof budget === "number" && budget < 1024) return { include_thoughts: Boolean(thinking.include_thoughts), budget_tokens: 1024 };
  return { include_thoughts: thinking.include_thoughts ?? true, budget_tokens: budget ?? 8192 };
}

function endpointUrl() {
  const base = process.env.NANOBANANA_ENDPOINT ?? "https://gpt-i18n.byteintl.net/gpt/openapi/online/v2/crawl";
  const ak = process.env.NANOBANANA_AK;
  if (!ak) throw new Error("Missing env NANOBANANA_AK");
  const url = new URL(base);
  url.searchParams.set("ak", ak);
  return url.toString();
}

function modelName() {
  return process.env.NANOBANANA_MODEL ?? "gemini-3-pro-preview-new";
}

export async function nanoBananaGeneratePosterSvg(input: NanoBananaGenerateSvgInput) {
  const thinking = normalizeThinking(input.thinking);
  const logId = input.logId ?? process.env.NANOBANANA_LOGID ?? `pg_${Math.random().toString(16).slice(2)}`;

  const system = [
    "You are a design generator that MUST output JSON only.",
    "Generate an SVG poster BACKGROUND with NO TEXT at all.",
    "Reserve a blank/clean area at the top for later text overlay.",
    "Do not include any letters, words, watermarks, logos, or typographic glyphs.",
    "SVG must be self-contained (no external images, no fonts).",
    "Use abstract shapes, gradients, patterns; modern and visually appealing.",
    "Return JSON keys: svg (string), prompt (string), negative_prompt (string), params (object)."
  ].join("\n");

  const user = [
    `Input meaning: ${input.text}`,
    `Canvas: ${input.width}x${input.height}`,
    `Seed: ${input.seed}`,
    "Style: modern, high-quality poster background, suitable for social media, leave top ~20% relatively clean for text."
  ].join("\n");

  const payload = {
    stream: false,
    model: modelName(),
    max_tokens: 4096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    thinking: thinking.budget_tokens === undefined ? undefined : { include_thoughts: thinking.include_thoughts, budget_tokens: thinking.budget_tokens }
  };

  const resp = await fetch(endpointUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TT-LOGID": logId
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(body || `NanoBanana HTTP ${resp.status}`);
  }

  const json = (await resp.json()) as any;
  const content: string | undefined =
    json?.choices?.[0]?.message?.content ??
    json?.data?.choices?.[0]?.message?.content ??
    json?.message?.content ??
    json?.content;
  if (!content || typeof content !== "string") {
    throw new Error("NanoBanana response missing message.content");
  }

  const parsed = safeParseJson(content);
  const validated = NanoBananaSvgResponseSchema.parse(parsed);

  return {
    svg: validated.svg,
    prompt: validated.prompt,
    negativePrompt: validated.negative_prompt,
    params: {
      model: modelName(),
      seed: input.seed,
      thinking,
      logId,
      ...(validated.params ?? {})
    }
  };
}

function safeParseJson(s: string) {
  const trimmed = s.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("NanoBanana content is not valid JSON");
  }
}
