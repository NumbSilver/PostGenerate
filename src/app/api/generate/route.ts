import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, publicDir } from "@/lib/storage";
import { generateFallbackPosterSvg } from "@/lib/svg-fallback";
import { nanoBanana3pGenerateImage } from "@/lib/nanobanana-3p";

export const runtime = "nodejs";

const BodySchema = z.object({
  text: z.string().min(1),
  size: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096)
  }),
  drawCount: z.number().int().min(1).max(12).default(4),
  includeNegative: z.boolean().optional().default(true),
  referenceImage: z
    .object({
      mimeType: z.string().min(1),
      base64: z.string().min(8)
    })
    .optional(),
  requestId: z.string().optional(),
  thinking: z
    .object({
      include_thoughts: z.boolean().optional(),
      budget_tokens: z.number().int().min(0).optional()
    })
    .optional()
});

function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());
  const { width, height } = body.size;

  const outDir = publicDir("generated");
  await ensureDir(outDir);

  const aspectRatio = toAspectRatio(width, height);
  const candidates = [];
  const drawCount = 1;
  for (let i = 0; i < drawCount; i++) {
    const seed = randomSeed();
    const id = `cand_${nanoid()}`;

    let imageBuffer: Buffer | null = null;
    let prompt: string;
    let negativePrompt: string | undefined;
    let params: Record<string, unknown>;
    let provider = "NanoBanana3P";
    let nanoBananaError: string | undefined;

    try {
      const gen = await nanoBanana3pGenerateImage({
        text: body.text,
        aspectRatio,
        seedTag: body.requestId ? `${body.requestId}_${i}` : `seed_${seed}_${i}`,
        includeNegative: body.includeNegative,
        referenceImage: body.referenceImage,
        thinking: body.thinking
          ? { include_thoughts: body.thinking.include_thoughts, budget_tokens: body.thinking.budget_tokens }
          : undefined
      });

      imageBuffer = Buffer.from(gen.base64, "base64");
      prompt = gen.prompt;
      negativePrompt = gen.negativePrompt;
      params = {
        model: process.env.NANOBANANA_3P_MODEL ?? "gemini-3-pro-image-preview",
        aspectRatio,
        seed,
        logId: gen.logId,
        ...(gen.params ?? {})
      };
    } catch (e) {
      nanoBananaError = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error("[generate] NanoBanana3P failed:", nanoBananaError);
      const fallback = generateFallbackPosterSvg({ width, height, seed });
      prompt = fallback.prompt;
      negativePrompt = fallback.negativePrompt;
      params = { seed, fallback: true, palette: fallback.palette, nanoBananaError };
      provider = "FallbackSVG";
    }

    let imageUrl: string;
    if (provider === "FallbackSVG") {
      const filename = `${id}.svg`;
      const abs = path.join(outDir, filename);
      const fallback = generateFallbackPosterSvg({ width, height, seed, includeNegative: body.includeNegative });
      await fs.writeFile(abs, fallback.svg, "utf8");
      imageUrl = `/generated/${filename}`;
    } else {
      const filename = `${id}.png`;
      const abs = path.join(outDir, filename);
      await fs.writeFile(abs, imageBuffer ?? Buffer.alloc(0));
      imageUrl = `/generated/${filename}`;
    }

    candidates.push({
      id,
      imageUrl,
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
  for (const s of supported) {
    const diff = Math.abs(ratio - s.v);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best.ar;
}
