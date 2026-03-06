import { NextResponse } from "next/server";
import { z } from "zod";
import type { PosterProject } from "@/lib/types";
import { dataDir, readJson } from "@/lib/storage";
import { exportProjectAsHtmlZip } from "@/lib/html-export";

export const runtime = "nodejs";

const BodySchema = z.object({
  projectId: z.string().min(1)
});

export async function POST(req: Request) {
  const body = BodySchema.parse(await req.json());
  const project = await readJson<PosterProject>(dataDir("projects", `${body.projectId}.json`));
  const zip = await exportProjectAsHtmlZip(project);
  const bytes = new Uint8Array(zip);

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="poster_${project.id}.zip"`
    }
  });
}
