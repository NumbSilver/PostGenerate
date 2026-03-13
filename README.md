# PostGenerate

输入两段信息（风格 + 文案）→ 先生成海报 A（含字）→ 再通过编辑接口生成海报 B（去字）→ 编辑器中 A 与 B 叠层调字 → Remotion 导出 PNG → 一键导出静态 HTML(zip)。

## 开发启动

```bash
pnpm install
pnpm approve-builds
pnpm dev
```

打开 `http://127.0.0.1:5174/generate`。

## 新增：现场写布局“代码”方案（不影响旧方案）

打开 `http://127.0.0.1:5174/generate-livecode`。
Livecode 独立技术方案见 `LIVE_CODE_TECH_SPEC.md`。

该方案会：
- 让大模型先理解脚本结构（标题/正文/列表/重点）
- 生成一段可读的“布局伪代码（类似 remotion/JS 思路）”用于解释布局
- 同时输出可执行的受限 `commands`（JSON program），服务端据此生成背景/元素并写入项目
- 最终进入现有 Canvas 编辑器（Konva）进行微调与导出

### Livecode 技术方案（关键部分）

#### 整体流程
1. 前端提交：脚本 + 素材清单 + 画布尺寸 + 风格提示（可选）
2. 后端调用结构理解 LLM：产出 `layoutCode + commands + background + stylePolicy`
3. 解析 JSON（严格校验 schema），并将 `stylePolicy` 写入 project meta
4. 背景亮度校正（基于 palette.background + 文本色）：
   - 计算文字与背景的对比度（contrast ratio）
   - 仅在低于 `stylePolicy.contrast.minRatio` 时触发增强（描边/阴影/半透明底图）
5. 执行 `commands`：
   - `text` 生成文字层
   - `asset` / `generated` 生成图片层
   - `rect` 生成可控的强调底图层
6. 落盘为 `project.json` → 进入 Konva 编辑器（可编辑/导出）

#### 依赖模型和服务
- 结构理解 LLM：`gpt-5.1-2025-11-13`（通过 `NANOBANANA_3P_BASE_URL`）
- LLM AK：优先 `GPT_5_1_AK`，否则回退 `GPT_I18N_AK / NANOBANANA_3P_AK`
- 生图服务：`NANOBANANA_3P_MODEL`（默认 `gpt-image-1.5`）
- 视觉校正：基于 `stylePolicy` 进行可读性增强（仅在对比度不足时启用）
- 编辑/导出：Konva 画布渲染 + Remotion 导出 PNG/HTML

#### 1. 目标与范围
- **目标**：把自然语言脚本转换为“可执行布局指令”，并结合生图背景/元素，产出可编辑海报。
- **范围**：独立于旧方案链路，新增 `generate-livecode` 页面与 `api/generate-livecode` 接口，不改动原方案。
- **输出**：结构化 JSON（布局 + 视觉策略），进入现有 Konva 编辑器进行可视化与导出。

#### 2. 端到端链路
1. 前端提交：脚本 + 素材清单 + 画布尺寸 + 风格提示（可选）
2. 后端调用结构理解 LLM：生成 `layoutCode + commands + background`
3. 解析 JSON（严格校验 schema）
4. 生图背景：使用 `background.prompt`
5. 执行 `commands`：
   - `text` 生成文字层
   - `asset` / `generated` 生成图片层
   - `rect` 生成可控的强调底图层
6. 落盘为 `project.json` → 进入 Konva 编辑器

#### 5. 可解析 JSON 设计（核心）
LLM 必须返回一个可被后端解析并执行的 JSON，核心字段如下：
```json
{
  "plan": "简短的技术方案/布局说明",
  "layoutCode": "人类可读的布局伪代码（仅用于解释，不执行）",
  "background": {
    "prompt": "背景生图提示词（禁止文字）",
    "negativePrompt": "可选"
  },
  "palette": { "background": "#0b0c10", "primary": "#ffffff", "secondary": "#b9c0cc", "accent": "#00f5d4" },
  "fonts": { "title": "Noto Sans SC, ...", "body": "Noto Sans SC, ...", "display": "Noto Sans SC, ..." },
  "stylePolicy": {
    "contrast": { "minRatio": 4.0, "softRatio": 3.0 },
    "roles": {
      "title": { "enable": true, "shadowColor": "rgba(0,0,0,0.6)", "shadowBlur": 12, "shadowOffsetY": 6 },
      "body": { "enable": true, "backdrop": { "enabled": true, "fillColor": "rgba(10,10,20,0.35)", "borderColor": "rgba(255,255,255,0.12)", "borderWidth": 1, "radius": 16, "padding": 12 } }
    }
  },
  "commands": [
    {
      "op": "text",
      "id": "title_1",
      "role": "title|subtitle|body|list|highlight|note",
      "text": "文本内容",
      "box": { "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.22 },
      "style": {
        "fontSize": 64,
        "fontWeight": 800,
        "color": "#FFFFFF",
        "align": "left",
        "lineHeight": 1.1,
        "stroke": "rgba(0,0,0,0.5)",
        "strokeWidth": 2,
        "shadowColor": "rgba(0,0,0,0.6)",
        "shadowBlur": 10,
        "shadowOffsetX": 0,
        "shadowOffsetY": 6,
        "shadowOpacity": 0.6
      }
    },
    {
      "op": "rect",
      "id": "backdrop_1",
      "role": "body",
      "box": { "x": 0.06, "y": 0.24, "w": 0.88, "h": 0.14 },
      "style": {
        "fillColor": "rgba(0,0,0,0.35)",
        "borderColor": "rgba(255,255,255,0.08)",
        "borderWidth": 1,
        "radius": 16
      }
    },
    {
      "op": "asset",
      "id": "asset_1",
      "assetIndex": 0,
      "box": { "x": 0.10, "y": 0.55, "w": 0.35, "h": 0.35 }
    },
    {
      "op": "generated",
      "id": "icon_1",
      "label": "装饰图形",
      "prompt": "与整体风格一致的装饰元素，单体，真实光影",
      "box": { "x": 0.70, "y": 0.60, "w": 0.20, "h": 0.20 }
    }
  ]
}
```
**解析原则**：
- `box` 支持 **比例(0-1)** 或 **像素值**，后端统一归一化为像素。
- `style` 内的视觉效果（阴影/描边/底图）**必须由模型显式给出**，后端不做默认强加。
- `rect` 用于生成可控的文字底图或强调块，确保与背景配色协调。
- `stylePolicy` 作为可读性兜底策略，仅在对比度不足时才会被执行。

#### 6. 文字可读性与视觉策略
- **不可默认套效果**：阴影/描边/底图只在必要时出现，由模型明确决定。
- **配色一致性**：模型需给出与背景协调的 `shadowColor / stroke / fillColor`，避免“脏黑遮挡”。
- **分层规则**：标题/重点可用高对比与轻量阴影，正文/列表优先用透明底图或轻描边。

#### 7. 可执行性与容错
- **Schema 校验**：返回 JSON 必须匹配 `commands` 结构，否则直接报错。
- **LLM 调用日志**：记录 `status / model / duration / logid`，便于定位 429 与空返回。
- **重试策略**：对空内容或解析失败会做有限重试，避免长 prompt 的偶发空 `content`。

## 生成流程（混合链路）

在生成页你需要填写两部分输入：
- 图片风格描述（例如：电影感、赛博朋克、极简高级灰）
- 图片文案内容（主标题 / 副标题 / 其他文字）
- 生图模型（`gpt-image-1.5` / `qwen-image` / `gemini-3-pro-image-preview`）

服务端会按以下顺序执行：
1. 调用生图接口生成海报 A（包含文案）
2. 调用 edit 接口基于海报 A 去除全部文字，得到海报 B（其余尽量保持不变）
3. （默认开启）对海报 A 做 OCR，提取文本框位置
4. （默认开启）估计 A→B 全局配准（平移/缩放/旋转），把 OCR 框映射到 B 坐标系
5. （默认开启）基于海报 A/B 做“差分候选框”提取（定位图1有而图2无的文字区域）
6. 采用 diff 主导 + OCR 修正融合，生成每条文案的行级锚点（line anchors）和旋转角
7. （默认开启）视觉模型补充样式（颜色/字号/字重/对齐）
8. 文本做自动拟合（换行/缩字号），OCR/diff 来源默认顶部贴齐，回退块默认居中
9. 进入编辑器时默认：A 作为底图，B 作为 50% 透明叠层，并自动放置文字图层
10. 点击「应用最终底图(B)」后会隐藏 A，仅保留 B+文字用于导出

文字图层采用“配准 + 差分 + OCR + 样式估计 + 拟合”策略：
- 配准先把 A 的检测结果映射到 B，降低编辑接口造成的轻微形变偏差
- 位置由 diff 主导，OCR 做几何修正；无法识别时自动回退
- 支持行级锚点与旋转角传递
- 再按像素宽度逐字符换行并自动缩字号，保证尽量不溢出
- 根据 `align` 做左/中/右对齐，非回退块优先顶部贴齐
- 编辑器提供「自动重排文字」按钮，可对当前所有文字层二次拟合

当生图模型选择 `gpt-image-1.5` 时，调用路径会切换为：
- `/gpt/openapi/online/v2/crawl/openai/images/generations`
- `size` 会自动映射到接口支持值：`1024x1024` / `1024x1536` / `1536x1024`

当生图模型选择 `gpt-image-1.5` 且传入参考图 `referenceImage` 时，会自动切换为：
- `/gpt/openapi/online/v2/crawl/openai/images/edits`
- 支持可选 `referenceMask`（需 alpha 通道）

## NanoBanana（第三方 multimodal/crawl）配置

复制 `.env.example` 为 `.env.local`，填入：
- `NANOBANANA_3P_AK`
- 可选：`NANOBANANA_3P_BASE_URL`（办公网通常是 `https://genai-sg-og.tiktok-row.org`）
- 可选：`NANOBANANA_3P_MODEL`（默认模型，页面也可临时切换；支持 `gpt-image-1.5` / `qwen-image` / `gemini-3-pro-image-preview`）
- 可选：`NANOBANANA_3P_OPENAI_IMAGE_QUALITY`（当模型为 `gpt-image-1.5` 时使用，默认 `low`）
- 可选：`NANOBANANA_3P_OCR_MODEL`（默认 `openai_qwen-vl-ocr-latest`）
- 可选：`NANOBANANA_3P_OCR_BASE_URL`（默认 `https://search.bytedance.net`）
- 可选：`NANOBANANA_3P_OCR_FALLBACK_BASE_URL`
- 可选：`NANOBANANA_3P_OCR_AK`（不填则复用 `NANOBANANA_3P_AK`）
- 可选：`NANOBANANA_3P_OCR_ENABLED`（默认 `1`，设 `0` 可关闭 OCR 融合）
- 可选：`NANOBANANA_3P_OCR_MAX_TOKENS`（默认 `1200`）
- 可选：`NANOBANANA_3P_OCR_RATE_LIMIT_WAIT_MS`（默认 `60000`，遇到 429 后等待再重试 1 次）
- 可选：`NANOBANANA_3P_VISION_MODEL`（视觉理解模型，不填则复用 OCR 模型）
- 可选：`NANOBANANA_3P_STYLE_HINT_ENABLED`（默认 `1`，设 `0` 可关闭颜色/字号分析）
- 可选：`NANOBANANA_3P_LOGID`

未配置或请求失败时会自动回退到本地随机 SVG 生成（仍保证无文字并预留顶部留白）。

## 导出
- 编辑页点击「导出PNG」：走 `Remotion + @remotion/renderer`
- 点击「导出HTML」：生成 `index.html + assets/ + project.json + meta.json` 的 zip
