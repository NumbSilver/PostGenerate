import path from "node:path";
import { promises as fs } from "node:fs";
import { bundle } from "@remotion/bundler";
import { getCompositions, renderStill } from "@remotion/renderer";

const projectFile = process.argv[2];
if (!projectFile) {
  console.error("Usage: pnpm remotion:render:png <project.json>");
  process.exit(1);
}

const project = JSON.parse(await fs.readFile(projectFile, "utf8"));
const serveUrl = await bundle({
  entryPoint: path.join(process.cwd(), "remotion", "index.ts"),
  outDir: path.join("/tmp", "postgenerate-remotion-bundle-cli")
});

const inputProps = { project };
const comps = await getCompositions(serveUrl, { inputProps });
const comp = comps.find((c) => c.id === "Poster");
if (!comp) throw new Error("Composition Poster not found");

const out = path.join(process.cwd(), `poster_${project.id ?? "out"}.png`);
await renderStill({ serveUrl, composition: comp, inputProps, output: out, imageFormat: "png" });
console.log(`Wrote ${out}`);
