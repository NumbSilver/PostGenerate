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

该方案会：
- 让大模型先理解脚本结构（标题/正文/列表/重点）
- 生成一段可读的“布局伪代码（类似 remotion/JS 思路）”用于解释布局
- 同时输出可执行的受限 `commands`（JSON program），服务端据此生成背景/元素并写入项目
- 最终进入现有 Canvas 编辑器（Konva）进行微调与导出

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
