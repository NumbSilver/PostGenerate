import path from "node:path";
import { promises as fs } from "node:fs";
import { publicDir } from "@/lib/storage";

export function isLocalPublicUrl(url: string) {
  return (
    url.startsWith("/generated/") ||
    url.startsWith("/generated-livecode/") ||
    url.startsWith("/generated-structured/") ||
    url.startsWith("/uploads/")
  );
}

export async function publicUrlToAbsolutePath(url: string) {
  const clean = url.replace(/^\/+/, "");
  return publicDir(clean);
}

export async function readAsDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  if (!isLocalPublicUrl(url)) return null;
  const abs = await publicUrlToAbsolutePath(url);
  const buf = await fs.readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".svg"
            ? "image/svg+xml"
            : "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
