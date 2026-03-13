"use client";

import React, { useMemo, useState } from "react";

type GenerateResult = {
  id: string;
  plan: string;
  layoutCode: string;
  background: { url: string; prompt: string };
  elements: Array<{ id: string; src: string }>;
  debug?: {
    llmContent?: string;
    llmResponsePreview?: string;
    logId?: string;
  };
};

export default function GenerateLiveCodePage() {
  const [script, setScript] = useState("");
  const [assetsText, setAssetsText] = useState("");
  const [styleHint, setStyleHint] = useState("");
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1920);
  const [readability, setReadability] = useState<"weak" | "medium" | "strong">("medium");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);

  const canGenerate = useMemo(() => script.trim().length > 0 && !loading, [script, loading]);

  async function onGenerate() {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch("/api/generate-livecode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script,
          assetsText,
          styleHint,
          readabilityLevel: readability,
          size: { width, height }
        })
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(body || `HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as GenerateResult;
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xl font-semibold">新新方案：脚本理解 → 现场写布局“代码” → 执行受限 program → 生图背景/元素 → Canvas</div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <div className="md:col-span-2">
          <label className="mb-2 block text-sm text-zinc-300">自然语言脚本</label>
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={10}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-zinc-500"
            placeholder="输入完整脚本，模型将识别标题/正文/列表/重点"
          />

          <label className="mb-2 mt-4 block text-sm text-zinc-300">素材清单（每行一条，支持 URL）</label>
          <textarea
            value={assetsText}
            onChange={(e) => setAssetsText(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-zinc-500"
            placeholder="示例：\n产品主图 | https://example.com/a.png\n城市夜景\nLogo | https://example.com/logo.png"
          />

          <label className="mb-2 mt-4 block text-sm text-zinc-300">风格提示（可选）</label>
          <textarea
            value={styleHint}
            onChange={(e) => setStyleHint(e.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm outline-none focus:border-zinc-500"
            placeholder="补充风格、品牌或色彩倾向"
          />

          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="mb-2 block text-sm text-zinc-300">宽度</label>
              <input
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm text-zinc-300">高度</label>
              <input
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-2 block text-sm text-zinc-300">文字可读性增强</label>
              <select
                value={readability}
                onChange={(e) => setReadability(e.target.value as "weak" | "medium" | "strong")}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-sm"
              >
                <option value="weak">弱（更克制）</option>
                <option value="medium">中（默认）</option>
                <option value="strong">强（更清晰）</option>
              </select>
            </div>
          </div>

          <button
            onClick={onGenerate}
            disabled={!canGenerate}
            className="mt-5 w-full rounded-lg bg-white px-4 py-2 text-sm font-semibold text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "生成中..." : "分析并生成"}
          </button>

          {error ? <div className="mt-3 text-sm text-red-400">{error}</div> : null}
        </div>

        <div className="md:col-span-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm text-zinc-400">生成结果预览</div>
            {!result ? (
              <div className="mt-3 text-sm text-zinc-500">提交脚本后会在这里展示布局“代码”、方案与预览图。</div>
            ) : (
              <div className="mt-4 space-y-4">
                {result.debug?.llmContent ? (
                  <div>
                    <div className="text-xs uppercase text-zinc-500">LLM Raw (content)</div>
                    <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-100">
                      {result.debug.llmContent}
                    </div>
                  </div>
                ) : null}

                {result.debug?.llmResponsePreview ? (
                  <div>
                    <div className="text-xs uppercase text-zinc-500">LLM Raw (response preview)</div>
                    <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-100">
                      {result.debug.llmResponsePreview}
                    </div>
                  </div>
                ) : null}

                {result.debug?.logId ? (
                  <div className="text-xs text-zinc-500">LLM LogId: {result.debug.logId}</div>
                ) : null}

                <div>
                  <div className="text-xs uppercase text-zinc-500">布局代码（可读伪代码）</div>
                  <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-100">
                    {result.layoutCode}
                  </div>
                </div>

                <div>
                  <div className="text-xs uppercase text-zinc-500">技术方案</div>
                  <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100">
                    {result.plan}
                  </div>
                </div>

                <div>
                  <div className="text-xs uppercase text-zinc-500">背景提示词</div>
                  <div className="mt-2 whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100">
                    {result.background.prompt}
                  </div>
                </div>

                <div>
                  <div className="text-xs uppercase text-zinc-500">背景图</div>
                  <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800">
                    <img src={result.background.url} alt="background" className="w-full object-cover" />
                  </div>
                </div>

                {result.elements.length > 0 ? (
                  <div>
                    <div className="text-xs uppercase text-zinc-500">元素预览</div>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      {result.elements.map((el) => (
                        <div key={el.id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
                          <img src={el.src} alt={el.id} className="h-48 w-full object-cover" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <button
                  onClick={() => (window.location.href = `/editor/${result.id}`)}
                  className="w-full rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-100"
                >
                  进入画布编辑
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
