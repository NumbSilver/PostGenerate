"use client";

import React, { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Text as KonvaText, Transformer } from "react-konva";
import useImage from "use-image";
import { nanoid } from "nanoid";

const DISPLAY_HEIGHT = 800;
const DISPLAY_WIDTH = 450;

type PosterProject = {
  id: string;
  createdAt: string;
  inputText: string;
  canvas: { width: number; height: number; background: { url: string } };
  meta: {
    provider: string;
    prompt: string;
    negativePrompt?: string;
    params: Record<string, unknown>;
  };
  layers: Array<TextLayer | ImageLayer>;
};

type BaseLayer = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
};

type TextLayer = BaseLayer & {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
};

type ImageLayer = BaseLayer & {
  type: "image";
  src: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function EditorClient({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<PosterProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const stageRef = useRef<any>(null);
  const transformerRef = useRef<any>(null);

  const [bg] = useImage(project?.canvas.background.url ?? "", "anonymous");

  const selectedLayer = React.useMemo(() => {
    if (!project || !selectedId) return null;
    return project.layers.find((l) => l.id === selectedId) ?? null;
  }, [project, selectedId]);

  useEffect(() => {
    async function load() {
      setError(null);
      try {
        const resp = await fetch(`/api/projects/${projectId}`);
        if (!resp.ok) throw new Error(await resp.text());
        const json = (await resp.json()) as PosterProject;
        setProject(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "加载失败");
      }
    }
    load();
  }, [projectId]);

  useEffect(() => {
    const tr = transformerRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const selected = selectedId ? stage.findOne(`#${selectedId}`) : null;
    tr.nodes(selected ? [selected] : []);
    tr.getLayer()?.batchDraw();
  }, [selectedId, project]);

  async function save(next: PosterProject) {
    setSaving(true);
    try {
      await fetch(`/api/projects/${next.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
    } finally {
      setSaving(false);
    }
  }

  function updateLayer(id: string, patch: Partial<TextLayer> | Partial<ImageLayer>) {
    if (!project) return;
    const next: PosterProject = {
      ...project,
      layers: project.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as typeof l) : l))
    };
    setProject(next);
    void save(next);
  }

  function removeSelected() {
    if (!project || !selectedId) return;
    const next: PosterProject = { ...project, layers: project.layers.filter((l) => l.id !== selectedId) };
    setProject(next);
    setSelectedId(null);
    void save(next);
  }

  async function addText() {
    if (!project) return;
    const id = `layer_${nanoid()}`;
    const next: PosterProject = {
      ...project,
      layers: [
        ...project.layers,
        {
          id,
          type: "text",
          x: 120,
          y: 120,
          w: 600,
          h: 120,
          rotation: 0,
          z: Date.now(),
          text: "输入文字",
          fontFamily: "system-ui",
          fontSize: 64,
          fontWeight: 700,
          color: "#ffffff",
          align: "left"
        }
      ]
    };
    setProject(next);
    setSelectedId(id);
    await save(next);
  }

  async function onUpload(file: File) {
    if (!project) return;
    const form = new FormData();
    form.append("file", file);
    const resp = await fetch("/api/assets/upload", { method: "POST", body: form });
    if (!resp.ok) throw new Error(await resp.text());
    const json = (await resp.json()) as { url: string; width?: number; height?: number };
    const id = `layer_${nanoid()}`;
    const next: PosterProject = {
      ...project,
      layers: [
        ...project.layers,
        {
          id,
          type: "image",
          x: 160,
          y: 400,
          w: 480,
          h: 480,
          rotation: 0,
          z: Date.now(),
          src: json.url
        }
      ]
    };
    setProject(next);
    setSelectedId(id);
    await save(next);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Backspace" || e.key === "Delete") {
        if ((e.target as HTMLElement | null)?.tagName?.toLowerCase() === "input") return;
        if ((e.target as HTMLElement | null)?.tagName?.toLowerCase() === "textarea") return;
        removeSelected();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, project]);

  async function copyMeta() {
    if (!project) return;
    const meta = JSON.stringify(project.meta, null, 2);
    await navigator.clipboard.writeText(meta);
  }

  async function exportHtml() {
    if (!project) return;
    const resp = await fetch("/api/export/html", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `poster_${project.id}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function renderPng() {
    if (!project) return;
    const resp = await fetch("/api/render/png", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id })
    });
    if (!resp.ok) throw new Error(await resp.text());
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `poster_${project.id}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!project) return <div className="p-6 text-sm text-zinc-400">加载中...</div>;

  return (
    <div className="grid h-screen grid-cols-1 grid-rows-1 md:grid-cols-[280px_1fr_360px]">
      <div className="min-h-0 overflow-auto border-r border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-3 text-sm font-semibold">工具</div>
        <button
          onClick={addText}
          className="mb-2 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-zinc-950"
        >
          添加文字
        </button>
        <label className="block w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-center text-sm text-zinc-200">
          上传素材
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
        </label>

        <div className="mt-6 text-xs text-zinc-500">
          <div>项目：{project.id}</div>
          <div>
            画布：{project.canvas.width}×{project.canvas.height}
          </div>
          <div>{saving ? "保存中..." : "已保存"}</div>
        </div>

        <div className="mt-6 flex gap-2">
          <button
            onClick={renderPng}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            导出PNG
          </button>
          <button
            onClick={exportHtml}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          >
            导出HTML
          </button>
        </div>
      </div>

      <div className="min-h-0 bg-zinc-900">
        <div className="flex h-full w-full items-center justify-center overflow-hidden">
          <div
            className="overflow-hidden rounded-xl shadow-2xl"
            style={{ width: `${DISPLAY_WIDTH}px`, height: `${DISPLAY_HEIGHT}px`, flex: "0 0 auto" }}
          >
            <Stage
              ref={stageRef}
              width={DISPLAY_WIDTH}
              height={DISPLAY_HEIGHT}
              scaleX={DISPLAY_WIDTH / project.canvas.width}
              scaleY={DISPLAY_HEIGHT / project.canvas.height}
              onMouseDown={(e) => {
                const clickedOnEmpty = e.target === e.target.getStage();
                if (clickedOnEmpty) setSelectedId(null);
              }}
            >
              <Layer>
                {bg ? (
                  <KonvaImage
                    listening={false}
                    perfectDrawEnabled={false}
                    image={bg}
                    x={0}
                    y={0}
                    width={project.canvas.width}
                    height={project.canvas.height}
                    crop={getCoverCrop(bg, project.canvas.width, project.canvas.height)}
                  />
                ) : null}
              </Layer>
              <Layer>
                {project.layers
                  .slice()
                  .sort((a, b) => a.z - b.z)
                  .map((layer) => {
                    if (layer.type === "text") {
                      return (
                        <KonvaText
                          key={layer.id}
                          id={layer.id}
                          name={layer.id}
                          text={layer.text}
                          x={layer.x}
                          y={layer.y}
                          width={layer.w}
                          height={layer.h}
                          rotation={layer.rotation}
                          fill={layer.color}
                          fontSize={layer.fontSize}
                          fontFamily={layer.fontFamily}
                          fontStyle={layer.fontWeight >= 700 ? "bold" : "normal"}
                          align={layer.align}
                          draggable
                          onClick={() => setSelectedId(layer.id)}
                          onTap={() => setSelectedId(layer.id)}
                          onDragEnd={(e) => updateLayer(layer.id, { x: e.target.x(), y: e.target.y() })}
                          onTransformEnd={(e) => {
                            const node = e.target;
                            const scaleX = node.scaleX();
                            const scaleY = node.scaleY();
                            node.scaleX(1);
                            node.scaleY(1);
                            updateLayer(layer.id, {
                              x: node.x(),
                              y: node.y(),
                              rotation: node.rotation(),
                              w: Math.max(20, node.width() * scaleX),
                              h: Math.max(20, node.height() * scaleY)
                            });
                          }}
                        />
                      );
                    }

                    return (
                      <CanvasImageLayer key={layer.id} layer={layer} onSelect={setSelectedId} onChange={updateLayer} />
                    );
                  })}

                <Transformer
                  ref={transformerRef}
                  rotateEnabled
                  enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
                />
              </Layer>
            </Stage>
          </div>
        </div>
      </div>

      <div className="min-h-0 overflow-auto border-l border-zinc-800 bg-zinc-950 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">属性 / Meta</div>
          <button onClick={copyMeta} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs">
            复制Meta
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 text-xs text-zinc-400">Prompt</div>
          <pre className="whitespace-pre-wrap break-words text-xs text-zinc-200">{project.meta.prompt}</pre>
          {project.meta.negativePrompt ? (
            <>
              <div className="mt-3 mb-2 text-xs text-zinc-400">Negative</div>
              <pre className="whitespace-pre-wrap break-words text-xs text-zinc-200">{project.meta.negativePrompt}</pre>
            </>
          ) : null}
          <div className="mt-3 mb-2 text-xs text-zinc-400">Params</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">
            {JSON.stringify(project.meta.params, null, 2)}
          </pre>
        </div>

        <div className="text-xs text-zinc-400">选中图层后可编辑；按 Delete 删除。</div>

        {selectedLayer ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="mb-2 text-sm font-medium">
              图层：{selectedLayer.type} / {selectedLayer.id}
            </div>
            {selectedLayer.type === "text" ? (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-xs text-zinc-400">文字</div>
                  <textarea
                    value={selectedLayer.text}
                    onChange={(e) => updateLayer(selectedLayer.id, { text: e.target.value })}
                    rows={4}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-xs outline-none focus:border-zinc-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="mb-1 text-xs text-zinc-400">字号</div>
                    <input
                      value={selectedLayer.fontSize}
                      type="number"
                      min={8}
                      max={256}
                      onChange={(e) => updateLayer(selectedLayer.id, { fontSize: Number(e.target.value) })}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-900 p-2 text-xs outline-none focus:border-zinc-500"
                    />
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-zinc-400">颜色</div>
                    <input
                      value={selectedLayer.color}
                      type="color"
                      onChange={(e) => updateLayer(selectedLayer.id, { color: e.target.value })}
                      className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 p-1"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <button
              onClick={removeSelected}
              className="mt-4 w-full rounded-lg bg-red-500/90 px-3 py-2 text-sm font-medium text-white"
            >
              删除图层
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CanvasImageLayer({
  layer,
  onSelect,
  onChange
}: {
  layer: ImageLayer;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<ImageLayer>) => void;
}) {
  const [img] = useImage(layer.src, "anonymous");
  return (
    <KonvaImage
      id={layer.id}
      image={img ?? undefined}
      x={layer.x}
      y={layer.y}
      width={layer.w}
      height={layer.h}
      rotation={layer.rotation}
      perfectDrawEnabled={false}
      draggable
      onClick={() => onSelect(layer.id)}
      onTap={() => onSelect(layer.id)}
      onDragEnd={(e) => onChange(layer.id, { x: e.target.x(), y: e.target.y() })}
      onTransformEnd={(e) => {
        const node = e.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scaleX(1);
        node.scaleY(1);
        onChange(layer.id, {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          w: Math.max(20, node.width() * scaleX),
          h: Math.max(20, node.height() * scaleY)
        });
      }}
    />
  );
}

function getCoverCrop(img: HTMLImageElement, targetW: number, targetH: number) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh || !targetW || !targetH) return undefined;

  const srcRatio = sw / sh;
  const targetRatio = targetW / targetH;

  if (srcRatio > targetRatio) {
    // Source is wider -> crop left/right.
    const cropW = Math.round(sh * targetRatio);
    const cropX = Math.round((sw - cropW) / 2);
    return { x: cropX, y: 0, width: cropW, height: sh };
  }

  // Source is taller -> crop top/bottom.
  const cropH = Math.round(sw / targetRatio);
  const cropY = Math.round((sh - cropH) / 2);
  return { x: 0, y: cropY, width: sw, height: cropH };
}
