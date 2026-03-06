"use client";

import React, { useMemo, useState } from "react";
import { nanoid } from "nanoid";

type Candidate = {
  id: string;
  imageUrl: string;
  meta: {
    prompt: string;
    negativePrompt?: string;
    params: Record<string, unknown>;
    provider: string;
  };
};

export default function GeneratePage() {
  const [text, setText] = useState("");
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1920);
  const [includeNegative, setIncludeNegative] = useState(true);
  const [referenceImage, setReferenceImage] = useState<{ mimeType: string; base64: string; name: string } | null>(
    null
  );
  const [sendThinking, setSendThinking] = useState<boolean>(false);
  const [thinkingBudget, setThinkingBudget] = useState<number>(8192);
  const [includeThoughts, setIncludeThoughts] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canGenerate = useMemo(() => text.trim().length > 0 && !loading, [text, loading]);

  async function readFileAsBase64(file: File) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    // Avoid call stack limits for large files.
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
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
          text,
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
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputText: text,
          canvas: { width, height, backgroundUrl: candidate.imageUrl },
          meta: candidate.meta
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
        <div className="text-xl font-semibold">输入文本 → 抽卡生成无文字海报（1 张）</div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="md:col-span-2">
          <label className="mb-2 block text-sm text-zinc-300">文本</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-zinc-500"
            placeholder="输入一段话，用来生成海报含义（海报不出字，留白给后续文字组件）"
          />

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
                加入 negative prompt（禁止文字/水印/Logo）
              </label>
            </div>
            <div className="mt-2 text-xs text-zinc-500">
              关闭后模型允许在海报里生成文字（适合需要 AI 自带文案的场景）。
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-200">参考图（可选）</div>
            {referenceImage ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xs text-zinc-200">{referenceImage.name}</div>
                  <div className="text-[11px] text-zinc-500">{referenceImage.mimeType}</div>
                </div>
                <button
                  onClick={() => setReferenceImage(null)}
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
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      const base64 = await readFileAsBase64(f);
                      setReferenceImage({ mimeType: f.type || "image/png", base64, name: f.name });
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "读取图片失败");
                    }
                  }}
                />
              </label>
            )}
            <div className="mt-2 text-xs text-zinc-500">不上传也可以生成；上传后会参考图片风格/构图。</div>
          </div>

          <button
            onClick={onGenerate}
            disabled={!canGenerate}
            className="mt-4 w-full rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
          >
            {loading ? "生成中..." : "抽卡生成（1张）"}
          </button>

          {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        </div>

        <div className="md:col-span-3">
          <div className="mb-2 text-sm text-zinc-300">候选</div>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-400">
              这里会展示候选海报。点击进入编辑器。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onChoose(c)}
                  className="group overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left"
                >
                  <div className="relative aspect-[9/16] w-full bg-zinc-950">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt="candidate"
                      src={c.imageUrl}
                      className="h-full w-full object-cover transition-transform group-hover:scale-[1.01]"
                    />
                  </div>
                  <div className="p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">provider: {c.meta.provider}</div>
                    <div className="line-clamp-2 text-xs text-zinc-400">{c.meta.prompt}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
