# Livecode 技术方案（独立版）

本文档只描述 `/generate-livecode` 链路，不影响旧方案。

## 目标
- 把自然语言脚本解析为结构化布局指令（JSON program）。
- 由模型给出文字/图形的层级、配色与必要的可读性策略。
- 在服务端生成背景与元素，并落盘为可编辑 project。

---

## 端到端步骤（含每一步 Prompt 与返回结构）

### Step 0：前端请求 /api/generate-livecode
**请求体（JSON）**
```json
{
  "script": "自然语言脚本",
  "assetsText": "素材清单（每行一条，可含 URL）",
  "styleHint": "风格补充（可选）",
  "size": { "width": 1080, "height": 1920 }
}
```

**说明**
- `assetsText` 每行一条，可写“素材说明 + URL”。
- `styleHint` 会被融合进风格约束提示。

---

### Step 1：结构理解 LLM 调用（生成 layout + commands + stylePolicy）
**请求目标**
- `POST {BASE_URL}/gpt/openapi/online/v2/crawl?ak=...`
- `model`: `gpt-5.1-2025-11-13`
- `max_tokens`: `4000`

**Prompt 结构（模板）**
```
系统角色：海报脚本理解→生成布局伪代码→生成受限布局指令的生成器
目标：识别标题/正文/列表/重点，并输出 layoutCode + commands
输出：严格 JSON，不要 Markdown

JSON Schema 示例：
{ ... schemaExample ... }

硬规则：
1) 只输出 JSON
2) box 用 0-1 比例（或像素）
3) background.prompt 禁止任何文字/LOGO
4) highlight 要醒目、list 要 bullet
5) 仅在需要时才使用阴影/描边/底图
6) 效果颜色需与背景协调，避免脏黑
7) 底图优先 text.backdrop / rect
8) 必须返回 stylePolicy
9) 必要元素无 URL 可用 generated

画布尺寸：{width}x{height}
设计风格约束：{styleHint}

输入脚本：
{script}

素材清单：
#0 label (url)
#1 ...
```

**返回结构（JSON）**
```json
{
  "plan": "技术方案简述",
  "layoutCode": "人类可读的布局伪代码字符串",
  "background": {
    "prompt": "背景生图提示词（禁止文字）",
    "negativePrompt": "可选"
  },
  "palette": {
    "background": "#0b0c10",
    "primary": "#ffffff",
    "secondary": "#b9c0cc",
    "accent": "#00f5d4"
  },
  "fonts": { "title": "...", "body": "...", "display": "..." },
  "stylePolicy": {
    "contrast": { "minRatio": 4.0, "softRatio": 3.0 },
    "roles": {
      "title": { "enable": true, "shadowColor": "...", "shadowBlur": 12, "shadowOffsetY": 6 },
      "body": { "enable": true, "backdrop": { "enabled": true, "fillColor": "..." } }
    }
  },
  "commands": [
    { "op": "text", "id": "title_1", "role": "title", "text": "...", "box": {"x":0.08,"y":0.12,"w":0.84,"h":0.22}, "style": {"fontSize":64,"fontWeight":800,"color":"#fff"}, "backdrop": {"enabled": false} },
    { "op": "asset", "id": "asset_1", "assetIndex": 0, "box": {"x":0.1,"y":0.55,"w":0.35,"h":0.35} },
    { "op": "generated", "id": "icon_1", "label": "装饰图形", "prompt": "...", "box": {"x":0.7,"y":0.6,"w":0.2,"h":0.2} },
    { "op": "rect", "id": "backdrop_1", "role": "body", "box": {"x":0.06,"y":0.24,"w":0.88,"h":0.14}, "style": {"fillColor":"rgba(10,10,20,0.35)","radius":16} }
  ]
}
```

---

### Step 2：背景生图调用
**请求参数（内部）**
- `text`: `background.prompt`
- `aspectRatio`: `width:height`
- `imageSize`: `1K | 2K`（取决于像素面积）
- `seedTag`: `bg_${nanoid}`
- `includeNegative`: `true`

**返回结构（内部）**
```json
{ "mimeType": "image/png", "base64": "..." }
```

---

### Step 3：元素处理
- `asset`：下载 URL → 转 base64 → 保存为 `/public/generated-livecode/*`。
- `generated`：调用生图生成元素 → 保存。
- `rect`：生成 SVG dataURI（作为可控底图/强调层）。

---

### Step 4：文字排版与可读性策略
- `box` 统一归一化为像素。
- `fitTextInBox` 自动换行与字号拟合。
- 可读性策略：
  - 计算文字颜色与 `palette.background` 的对比度。
  - 只有在低于 `stylePolicy.contrast.minRatio` 且 `role.enable=true` 时才启用描边/阴影/底图。
  - `backdrop` 仅在模型显式指定或策略触发时生成。

---

### Step 5：落盘与返回
**落盘（project.json）**
- `meta.params` 保存 `plan/layoutCode/commands/palette/fonts/stylePolicy/backgroundUrl`。
- `layers` 包含 `text/image` 图层，`text_backdrop` 作为可锁定层。

**API 响应**
```json
{
  "id": "proj_xxx",
  "plan": "...",
  "layoutCode": "...",
  "background": { "url": "/generated-livecode/bg_xxx.png", "prompt": "..." },
  "elements": [ { "id": "layer_xxx", "src": "/generated-livecode/element_xxx.png" } ],
  "debug": { "llmContent": "...", "llmResponsePreview": "...", "logId": "pg_..." }
}
```

---

## 错误处理与重试
- LLM 返回非 2xx、空 content 或 JSON 解析失败：最多重试 3 次。
- API 返回 429/500：透出原始错误文本，便于定位额度/限流。
- Schema 校验失败：直接报错，不生成项目。

---

## 关键依赖
- LLM：`gpt-5.1-2025-11-13`
- Image：`NANOBANANA_3P_MODEL`（默认 `gpt-image-1.5`）
- Editor：Konva + Remotion 导出
