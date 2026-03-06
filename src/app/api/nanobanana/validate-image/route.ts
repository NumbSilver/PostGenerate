import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const BodySchema = z.object({
  // Either a public URL or a data URI: data:image/png;base64,...
  image: z.string().min(8),
  model: z.string().min(1).optional()
});

function baseUrl() {
  return process.env.NANOBANANA_3P_BASE_URL ?? "https://genai-sg-og.tiktok-row.org";
}

function ak() {
  const value = process.env.NANOBANANA_3P_AK;
  if (!value) throw new Error("Missing env NANOBANANA_3P_AK");
  return value;
}

function logId() {
  return `validate_${Math.random().toString(16).slice(2)}`;
}

type Variant = { name: string; part: unknown };

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());

  const variants: Variant[] = [
    { name: "type=image_url; image_url={url}", part: { type: "image_url", image_url: { url: body.image } } },
    {
      name: "type=image_url; image_url={url,mime_type}",
      part: { type: "image_url", image_url: { url: body.image, mime_type: "image/png" } }
    },
    {
      name: "type=image_url; image_url={url,mimeType}",
      part: { type: "image_url", image_url: { url: body.image, mimeType: "image/png" } }
    },
    {
      name: "type=image_url; image_url={data,mime_type}",
      part: { type: "image_url", image_url: { data: body.image, mime_type: "image/png" } }
    },
    {
      name: "type=image_url; image_url={data,mimeType}",
      part: { type: "image_url", image_url: { data: body.image, mimeType: "image/png" } }
    },
    {
      name: "type=inline_data; inline_data={mime_type,data}",
      part: { type: "inline_data", inline_data: { mime_type: "image/png", data: body.image } }
    },
    { name: "type=image; image_url=string", part: { type: "image", image_url: body.image } },
    { name: "type=mage; image_url=string", part: { type: "mage", image_url: body.image } },
    { name: "type=image; image_url={url,mime_type}", part: { type: "image", image_url: { url: body.image, mime_type: "image/png" } } }
  ];

  const results: Array<{ name: string; ok: boolean; status: number; bodySnippet: string }> = [];

  for (const v of variants) {
    const url = new URL("/gpt/openapi/online/multimodal/crawl", baseUrl());
    url.searchParams.set("ak", ak());

    const payload = {
      stream: false,
      model: body.model ?? process.env.NANOBANANA_3P_VALIDATE_MODEL ?? "gemini-3-pro-image-preview",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "请简短回答：这张参考图的主体是什么？" },
            v.part as any
          ]
        }
      ],
      response_modalities: ["TEXT"]
    };

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TT-LOGID": logId() },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    results.push({
      name: v.name,
      ok: resp.ok,
      status: resp.status,
      bodySnippet: text.slice(0, 300)
    });
  }

  return NextResponse.json({ results });
}
