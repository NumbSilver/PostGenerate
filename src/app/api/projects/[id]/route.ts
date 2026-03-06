import { NextResponse } from "next/server";
import { z } from "zod";
import type { PosterProject } from "@/lib/types";
import { dataDir, exists, readJson, writeJson } from "@/lib/storage";

export const runtime = "nodejs";

const ProjectSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  inputText: z.string().min(1),
  canvas: z.object({
    width: z.number().int(),
    height: z.number().int(),
    background: z.object({ url: z.string().min(1) })
  }),
  meta: z.object({
    provider: z.string().min(1),
    prompt: z.string().min(1),
    negativePrompt: z.string().optional(),
    params: z.record(z.unknown())
  }),
  layers: z.array(
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
        align: z.union([z.literal("left"), z.literal("center"), z.literal("right")])
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
        src: z.string().min(1)
      })
    ])
  )
});

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const file = dataDir("projects", `${params.id}.json`);
  if (!(await exists(file))) {
    return new NextResponse("Not found", { status: 404 });
  }
  const project = await readJson<PosterProject>(file);
  return NextResponse.json(project);
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const file = dataDir("projects", `${params.id}.json`);
  const json = await req.json();
  const project = ProjectSchema.parse(json) as PosterProject;
  if (project.id !== params.id) {
    return new NextResponse("Project id mismatch", { status: 400 });
  }
  await writeJson(file, project);
  return NextResponse.json({ ok: true });
}
