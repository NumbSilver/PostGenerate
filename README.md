# PostGenerate

输入两段信息（风格 + 文案）→ 先生成海报 A（含字）→ 再通过编辑接口生成海报 B（去字）→ 编辑器中 A 与 B 叠层调字 → Remotion 导出 PNG → 一键导出静态 HTML(zip)。

## 开发启动

```bash
pnpm install
pnpm approve-builds
pnpm dev
```

打开 `http://127.0.0.1:5174/generate`。

## 生成流程（混合链路）

在生成页你需要填写两部分输入：
- 图片风格描述（例如：电影感、赛博朋克、极简高级灰）
- 图片文案内容（主标题 / 副标题 / 其他文字）
- 生图模型（`gpt-image-1.5` / `qwen-image` / `gemini-3-pro-image-preview`）

服务端会按以下顺序执行：
1. 调用 NanoBanana 产出排版方案 JSON（位置、字号、颜色、对齐等）
2. 调用生图接口生成海报 A（包含文案）
3. 调用 edit 接口基于海报 A 去除全部文字，得到海报 B（其余尽量保持不变）
4. （默认开启）对海报 A 做 OCR，提取文本框并和排版 JSON 融合，得到更贴近原图的文字位置
5. （默认开启）基于海报A/B做样式分析，自动估计字号、文字颜色与是否需要半透明蒙层
6. 进入编辑器时默认：A 作为底图，B 作为 50% 透明叠层，并自动放置文字图层
7. 点击「应用最终底图(B)」后会隐藏 A，仅保留 B+文字用于导出

文字图层采用“框选区拟合”对齐策略：
- 先按排版 JSON 的区块作为文字盒子（x/y/w/h）
- 再按像素宽度逐字符换行并自动缩字号，保证尽量不溢出
- 根据 `align` 做左/中/右对齐，并做垂直居中
- 背景复杂时可自动给文字加半透明蒙层（panel）
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
- 可选：`NANOBANANA_3P_LAYOUT_MODEL`（排版 JSON 的模型，不填则复用 `NANOBANANA_3P_MODEL`）
- 可选：`NANOBANANA_3P_OCR_MODEL`（默认 `openai_qwen-vl-ocr-latest`）
- 可选：`NANOBANANA_3P_OCR_BASE_URL`（默认 `https://search.bytedance.net`）
- 可选：`NANOBANANA_3P_OCR_FALLBACK_BASE_URL`
- 可选：`NANOBANANA_3P_OCR_AK`（不填则复用 `NANOBANANA_3P_AK`）
- 可选：`NANOBANANA_3P_OCR_ENABLED`（默认 `1`，设 `0` 可关闭 OCR 融合）
- 可选：`NANOBANANA_3P_OCR_MAX_TOKENS`（默认 `1200`）
- 可选：`NANOBANANA_3P_OCR_RATE_LIMIT_WAIT_MS`（默认 `60000`，遇到 429 后等待再重试 1 次）
- 可选：`NANOBANANA_3P_STYLE_HINT_ENABLED`（默认 `1`，设 `0` 可关闭颜色/字号/蒙层分析）
- 可选：`NANOBANANA_3P_LOGID`

未配置或请求失败时会自动回退到本地随机 SVG 生成（仍保证无文字并预留顶部留白）。

## 导出
- 编辑页点击「导出PNG」：走 `Remotion + @remotion/renderer`
- 点击「导出HTML」：生成 `index.html + assets/ + project.json + meta.json` 的 zip
