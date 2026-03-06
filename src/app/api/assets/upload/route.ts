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
  if (!file || !(file instanceof File)) {
    return new NextResponse("Missing file", { status: 400 });
  }

  const ext = safeExt(file.name);
  const id = `up_${nanoid()}`;
  const outDir = publicDir("uploads");
  await ensureDir(outDir);
  const filename = `${id}${ext}`;
  const abs = path.join(outDir, filename);

  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  return NextResponse.json({ url: `/uploads/${filename}` });
}

