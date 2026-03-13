import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ensureDir, publicDir } from "@/lib/storage";

export const runtime = "nodejs";

function safeExt(name: string) {
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return ext;
  return ".png";
}

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!file || !(file instanceof Blob)) {
    return new NextResponse("Missing file", { status: 400 });
  }

  const filename = typeof (file as { name?: string }).name === "string" ? (file as { name: string }).name : "upload.png";
  const ext = safeExt(filename);
  const id = `up_${nanoid()}`;
  const outDir = publicDir("uploads");
  await ensureDir(outDir);
  const outputName = `${id}${ext}`;
  const abs = path.join(outDir, outputName);

  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  return NextResponse.json({ url: `/uploads/${outputName}` });
}
