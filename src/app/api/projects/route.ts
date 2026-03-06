import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { PosterProject } from "@/lib/types";
import { dataDir, writeJson } from "@/lib/storage";

export const runtime = "nodejs";

const BodySchema = z.object({
  inputText: z.string().min(1),
  canvas: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
    backgroundUrl: z.string().min(1)
  }),
  meta: z.object({
    provider: z.string().min(1),
    prompt: z.string().min(1),
    negativePrompt: z.string().optional(),
    params: z.record(z.unknown())
  })
});

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());
  const id = `proj_${nanoid()}`;

  const project: PosterProject = {
    id,
    createdAt: new Date().toISOString(),
    inputText: body.inputText,
    canvas: {
      width: body.canvas.width,
      height: body.canvas.height,
      background: { url: body.canvas.backgroundUrl }
    },
    meta: {
      provider: body.meta.provider,
      prompt: body.meta.prompt,
      negativePrompt: body.meta.negativePrompt,
      params: body.meta.params
    },
    layers: []
  };

  await writeJson(dataDir("projects", `${id}.json`), project);
  return NextResponse.json({ id });
}

