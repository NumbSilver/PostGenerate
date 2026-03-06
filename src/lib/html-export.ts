import JSZip from "jszip";
import path from "node:path";
import { promises as fs } from "node:fs";
import { isLocalPublicUrl, publicUrlToAbsolutePath } from "@/lib/asset";
import type { PosterProject } from "@/lib/types";

export async function exportProjectAsHtmlZip(project: PosterProject) {
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify(project, null, 2) + "\n");
  zip.file("meta.json", JSON.stringify(project.meta, null, 2) + "\n");

  const assetsFolder = zip.folder("assets");

  const bg = await materializeAsset(project.canvas.background.url, assetsFolder);
  const layerAssets = new Map<string, string>();
  for (const layer of project.layers) {
    if (layer.type === "image") {
      const exported = await materializeAsset(layer.src, assetsFolder);
      if (exported) layerAssets.set(layer.src, exported);
    }
  }

  const html = renderHtml({
    project,
    backgroundSrc: bg ?? project.canvas.background.url,
    rewriteSrc: (src) => layerAssets.get(src) ?? src
  });
  zip.file("index.html", html);

  return await zip.generateAsync({ type: "nodebuffer" });
}

async function materializeAsset(
  src: string,
  assetsFolder: JSZip | null
): Promise<string | null> {
  if (!assetsFolder) return null;
  if (!isLocalPublicUrl(src)) return null;
  const abs = await publicUrlToAbsolutePath(src);
  const filename = path.basename(abs);
  const buf = await fs.readFile(abs);
  assetsFolder.file(filename, buf);
  return `assets/${filename}`;
}

function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderHtml({
  project,
  backgroundSrc,
  rewriteSrc
}: {
  project: PosterProject;
  backgroundSrc: string;
  rewriteSrc: (src: string) => string;
}) {
  const { width, height } = project.canvas;
  const layers = project.layers
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((layer) => {
      const baseStyle = `position:absolute;left:${layer.x}px;top:${layer.y}px;width:${layer.w}px;height:${layer.h}px;transform:rotate(${layer.rotation}deg);transform-origin:top left;`;
      if (layer.type === "text") {
        const style = `${baseStyle}color:${layer.color};font-family:${escapeHtml(layer.fontFamily)};font-size:${layer.fontSize}px;font-weight:${layer.fontWeight};white-space:pre-wrap;line-height:1.2;text-align:${layer.align};`;
        return `<div style="${style}">${escapeHtml(layer.text)}</div>`;
      }
      const src = rewriteSrc(layer.src);
      return `<img alt="" src="${escapeHtml(src)}" style="${baseStyle}object-fit:contain;" />`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Poster</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0b0b0f; }
      .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
      .canvas { position: relative; width: ${width}px; height: ${height}px; background: #000; box-shadow: 0 20px 80px rgba(0,0,0,0.55); border-radius: 16px; overflow: hidden; }
      .canvas > img.bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="canvas">
        <img class="bg" alt="" src="${escapeHtml(backgroundSrc)}" />
        ${layers}
      </div>
    </div>
  </body>
</html>`;
}

