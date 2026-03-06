import { promises as fs } from "node:fs";
import path from "node:path";

export function repoRoot() {
  return process.cwd();
}

export function dataDir(...parts: string[]) {
  return path.join(repoRoot(), "data", ...parts);
}

export function publicDir(...parts: string[]) {
  return path.join(repoRoot(), "public", ...parts);
}

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function exists(filePath: string) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

