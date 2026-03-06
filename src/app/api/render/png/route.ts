import { NextResponse } from "next/server";
import { z } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderStill } from "@remotion/renderer";
import type { PosterProject } from "@/lib/types";
import { dataDir, ensureDir, readJson } from "@/lib/storage";
import { readAsDataUrl } from "@/lib/asset";

export const runtime = "nodejs";

const BodySchema = z.object({
  projectId: z.string().min(1)
});

let serveUrlPromise: Promise<string> | null = null;

async function getServeUrl() {
  if (!serveUrlPromise) {
    serveUrlPromise = (async () => {
      const outDir = path.join("/tmp", "postgenerate-remotion-bundle");
      await ensureDir(outDir);
      const entryPoint = path.join(process.cwd(), "remotion", "index.ts");
      return await bundle({ entryPoint, outDir });
    })();
  }
  return await serveUrlPromise;
}

async function materializeProjectAssets(project: PosterProject): Promise<PosterProject> {
  const bg = (await readAsDataUrl(project.canvas.background.url)) ?? project.canvas.background.url;
  const layers = await Promise.all(
    project.layers.map(async (layer) => {
      if (layer.type !== "image") return layer;
      const dataUrl = await readAsDataUrl(layer.src);
      return dataUrl ? { ...layer, src: dataUrl } : layer;
    })
  );
  return {
    ...project,
    canvas: { ...project.canvas, background: { url: bg } },
    layers
  };
}

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());
  const project = await readJson<PosterProject>(dataDir("projects", `${body.projectId}.json`));
  const renderProject = await materializeProjectAssets(project);

  const serveUrl = await getServeUrl();
  const inputProps = { project: renderProject };

  const comps = await getCompositions(serveUrl, { inputProps });
  const comp = comps.find((c) => c.id === "Poster");
  if (!comp) return new NextResponse("Composition not found", { status: 500 });

  const outFile = path.join("/tmp", `poster_${project.id}.png`);
  await renderStill({
    serveUrl,
    composition: comp,
    inputProps,
    output: outFile,
    imageFormat: "png"
  });

  const buf = await fs.readFile(outFile);
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="poster_${project.id}.png"`
    }
  });
}
