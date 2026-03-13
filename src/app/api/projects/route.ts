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
  }),
  layers: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("text"),
          id: z.string().min(1),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          rotation: z.number(),
          z: z.number(),
          text: z.string(),
          fontFamily: z.string(),
          fontSize: z.number(),
          fontWeight: z.number(),
          color: z.string(),
          align: z.union([z.literal("left"), z.literal("center"), z.literal("right")]),
          lineHeight: z.number().min(0.8).max(3).optional(),
          letterSpacing: z.number().optional(),
          opacity: z.number().min(0).max(1).optional(),
          stroke: z.string().optional(),
          strokeWidth: z.number().optional(),
          shadowColor: z.string().optional(),
          shadowBlur: z.number().optional(),
          shadowOffsetX: z.number().optional(),
          shadowOffsetY: z.number().optional(),
          shadowOpacity: z.number().optional()
        }),
        z.object({
          type: z.literal("image"),
          id: z.string().min(1),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          rotation: z.number(),
          z: z.number(),
          src: z.string().min(1),
          opacity: z.number().min(0).max(1).optional(),
          visible: z.boolean().optional(),
          locked: z.boolean().optional(),
          role: z.union([z.literal("asset"), z.literal("guide_b_overlay"), z.literal("text_backdrop")]).optional()
        })
      ])
    )
    .optional()
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
    layers: body.layers ?? []
  };

  await writeJson(dataDir("projects", `${id}.json`), project);
  return NextResponse.json({ id });
}
