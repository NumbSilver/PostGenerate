"use client";

import React, { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import type { PosterImageLayer, PosterTextLayer } from "@/lib/types";

type Candidate = {
  id: string;
  imageUrl: string;
  editorBackgroundUrl?: string;
  layers: Array<PosterTextLayer | PosterImageLayer>;
  meta: {
    prompt: string;
    negativePrompt?: string;
    params: Record<string, unknown>;
    provider: string;
  };
};

function parseOtherLines(input: string) {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export default function GeneratePage() {
  const [imageModel, setImageModel] = useState<"gemini-3-pro-image-preview" | "qwen-image" | "gpt-image-1.5">("gpt-image-1.5");
  const [stylePrompt, setStylePrompt] = useState("");
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [otherText, setOtherText] = useState("");
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1920);
  const [includeNegative, setIncludeNegative] = useState(false);
  const [referenceImage, setReferenceImage] = useState<{
    mimeType: string;
    base64: string;
    name: string;
    palette: string[];
  } | null>(null);
  const [referenceImageUrl, setReferenceImageUrl] = useState<string>("");
  const [sendThinking, setSendThinking] = useState<boolean>(false);
  const [thinkingBudget, setThinkingBudget] = useState<number>(8192);
  const [includeThoughts, setIncludeThoughts] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canGenerate = useMemo(() => stylePrompt.trim().length > 0 && title.trim().length > 0 && !loading, [stylePrompt, title, loading]);

  async function readFileAsBase64(file: File) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function extractPalette(file: File): Promise<string[]> {
    const bitmap = await createImageBitmap(file);
    const targetW = 96;
    const targetH = Math.max(1, Math.round((bitmap.height / bitmap.width) * targetW));
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const { data } = ctx.getImageData(0, 0, targetW, targetH);

    const buckets = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] ?? 255;
      if (a < 16) continue;
      const r = (data[i] ?? 0) >> 4;
      const g = (data[i + 1] ?? 0) >> 4;
      const b = (data[i + 2] ?? 0) >> 4;
      const key = (r << 8) | (g << 4) | b;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const top = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key]) => {
        const r = ((key >> 8) & 0xf) * 17;
        const g = ((key >> 4) & 0xf) * 17;
        const b = (key & 0xf) * 17;
        return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      });

    return Array.from(new Set(top));
  }

  async function onGenerate() {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    setCandidates([]);
    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageModel,
          stylePrompt,
          textContent: {
            title,
            subtitle: subtitle.trim() || undefined,
            others: parseOtherLines(otherText)
          },
          size: { width, height },
          drawCount: 1,
          requestId: nanoid(),
          includeNegative,
          referenceImage: referenceImage
            ? {
                mimeType: referenceImage.mimeType,
                base64: referenceImage.base64
              }
            : undefined,
          referenceStyle: referenceImage ? { palette: referenceImage.palette } : undefined,
          ...(sendThinking
            ? {
                thinking: {
                  include_thoughts: includeThoughts,
                  budget_tokens: thinkingBudget
                }
              }
            : {})
        })
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(body || `HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as { candidates: Candidate[] };
      setCandidates(json.candidates);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  async function onChoose(candidate: Candidate) {
    setLoading(true);
    setError(null);
    try {
      const inputText = [
        `风格：${stylePrompt}`,
        `主标题：${title}`,
        subtitle.trim() ? `副标题：${subtitle.trim()}` : "",
        ...parseOtherLines(otherText).map((line, index) => `其他文字${index + 1}：${line}`)
      ]
        .filter(Boolean)
        .join("\n");

      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputText,
          canvas: { width, height, backgroundUrl: candidate.editorBackgroundUrl ?? candidate.imageUrl },
          meta: candidate.meta,
          layers: candidate.layers
        })
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(body || `HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as { id: string };
      window.location.href = `/editor/${json.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建项目失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xl font-semibold">先生成海报A（含字）→ 再编辑生成海报B（去字）→ 进入画布叠层调字</div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="md:col-span-2">
          <label className="mb-2 block text-sm text-zinc-300">图片风格描述</label>
          <textarea
            value={stylePrompt}
            onChange={(e) => setStylePrompt(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-zinc-500"
            placeholder="例如：赛博朋克夜景，霓虹灯反射，电影海报质感，强对比，留白区域用于标题。"
          />

          <div className="mt-3">
            <label className="mb-1 block text-xs text-zinc-400">生图模型</label>
            <select
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value as "gemini-3-pro-image-preview" | "qwen-image" | "gpt-image-1.5")}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
            >
              <option value="gpt-image-1.5">gpt-image-1.5</option>
              <option value="qwen-image">qwen-image</option>
              <option value="gemini-3-pro-image-preview">gemini-3-pro-image-preview</option>
            </select>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-200">要展示的文字内容</div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">主标题（必填）</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
                  placeholder="输入主标题"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">副标题（可选）</label>
                <input
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
                  placeholder="输入副标题"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">其他文字（可选，每行一条）</label>
                <textarea
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
                  placeholder={"例如：\n3月20日 19:30\n上海东方艺术中心"}
                />
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">宽度</label>
              <input
                value={width}
                type="number"
                min={320}
                max={4096}
                onChange={(e) => setWidth(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">高度</label>
              <input
                value={height}
                type="number"
                min={320}
                max={4096}
                onChange={(e) => setHeight(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-200">NanoBanana Thinking（可选）</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">budget_tokens（0=关闭）</label>
                <input
                  value={thinkingBudget}
                  type="number"
                  min={0}
                  max={32768}
                  onChange={(e) => setThinkingBudget(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
                />
              </div>
              <div className="flex items-end gap-2">
                <input
                  id="send_thinking"
                  type="checkbox"
                  checked={sendThinking}
                  onChange={(e) => setSendThinking(e.target.checked)}
                  className="h-4 w-4 accent-white"
                />
                <label htmlFor="send_thinking" className="text-xs text-zinc-300">
                  传 thinking
                </label>
                <input
                  id="include_thoughts"
                  type="checkbox"
                  checked={includeThoughts}
                  onChange={(e) => setIncludeThoughts(e.target.checked)}
                  className="h-4 w-4 accent-white"
                />
                <label htmlFor="include_thoughts" className="text-xs text-zinc-300">
                  include_thoughts
                </label>
              </div>
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              不传时默认 8192；小于 1024 会被提升到 1024；设为 0 关闭 thinking。
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-200">生成约束</div>
            <div className="flex items-center gap-2">
              <input
                id="include_negative"
                type="checkbox"
                checked={includeNegative}
                onChange={(e) => setIncludeNegative(e.target.checked)}
                className="h-4 w-4 accent-white"
              />
              <label htmlFor="include_negative" className="text-xs text-zinc-300">
                加入 negative prompt（背景图禁止文字/水印/Logo）
              </label>
            </div>
            <div className="mt-2 text-xs text-zinc-500">默认关闭；如需更强去字约束可手动开启。</div>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-200">参考图（可选）</div>
            <div className="mb-3">
              <label className="mb-1 block text-[11px] text-zinc-500">参考图 URL（可选，需外网可访问）</label>
              <div className="flex gap-2">
                <input
                  value={referenceImageUrl}
                  onChange={(e) => setReferenceImageUrl(e.target.value)}
                  placeholder="https://example.com/image.png"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm outline-none focus:border-zinc-500"
                />
                <button
                  type="button"
                  onClick={() => {
                    const url = referenceImageUrl.trim();
                    if (!url) return;
                    setReferenceImage({
                      mimeType: "image/*",
                      base64: url,
                      name: url,
                      palette: []
                    });
                  }}
                  className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                >
                  使用
                </button>
              </div>
            </div>
            {referenceImage ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs text-zinc-200">{referenceImage.name}</div>
                  <div className="text-[11px] text-zinc-500">{referenceImage.mimeType}</div>
                  {referenceImage.palette.length ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {referenceImage.palette.map((color) => (
                        <div key={color} className="h-4 w-4 rounded border border-zinc-700" style={{ background: color }} />
                      ))}
                    </div>
                  ) : null}
                </div>
                <button
                  onClick={() => {
                    setReferenceImage(null);
                    setReferenceImageUrl("");
                  }}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs"
                >
                  移除
                </button>
              </div>
            ) : (
              <label className="block w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-center text-sm text-zinc-200">
                上传参考图
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try {
                      const palette = await extractPalette(file);
                      const raw = await readFileAsBase64(file);
                      const mimeType = file.type || "image/png";
                      const base64 = `data:${mimeType};base64,${raw}`;
                      setReferenceImage({ mimeType, base64, name: file.name, palette });
                      setReferenceImageUrl("");
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "读取图片失败");
                    }
                  }}
                />
              </label>
            )}
            <div className="mt-2 text-xs text-zinc-500">
              上传后会尝试以 data URI 直传参考图，若网关不支持则自动降级为配色风格提示。
            </div>
          </div>

          <button
            onClick={onGenerate}
            disabled={!canGenerate}
            className="mt-4 w-full rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
          >
            {loading ? "生成中..." : "生成候选（自动含文字图层）"}
          </button>

          {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        </div>

        <div className="md:col-span-3">
          <div className="mb-2 text-sm text-zinc-300">候选</div>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-400">
              这里会展示候选海报。点击任意候选进入编辑器，可直接微调自动排版后的文字图层。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {candidates.map((candidate) => (
                (() => {
                  const posterAUrl =
                    (typeof candidate.meta.params.posterAUrl === "string" ? candidate.meta.params.posterAUrl : undefined) ??
                    candidate.editorBackgroundUrl ??
                    candidate.imageUrl;
                  const posterBUrl =
                    (typeof candidate.meta.params.posterBUrl === "string" ? candidate.meta.params.posterBUrl : undefined) ??
                    candidate.imageUrl;
                  return (
                <button
                  key={candidate.id}
                  onClick={() => onChoose(candidate)}
                  className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left"
                >
                  <div className="grid grid-cols-2 gap-2 bg-zinc-950 p-2">
                    <div>
                      <div className="mb-1 text-[11px] text-zinc-500">去字前 A</div>
                      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          alt="candidate-a"
                          src={posterAUrl}
                          className="h-full w-full rounded object-cover transition-transform group-hover:scale-[1.01]"
                        />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] text-zinc-500">去字后 B</div>
                      <div className="relative" style={{ aspectRatio: `${width} / ${height}` }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          alt="candidate-b"
                          src={posterBUrl}
                          className="h-full w-full rounded object-cover transition-transform group-hover:scale-[1.01]"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">provider: {candidate.meta.provider}</div>
                    <div className="line-clamp-2 text-xs text-zinc-400">{candidate.meta.prompt}</div>
                  </div>
                </button>
                  );
                })()
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
