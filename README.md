# PostGenerate

输入一段话 → 抽卡生成「无文字」海报背景（SVG）→ 进入编辑器叠加文字/素材 → Remotion 导出 PNG → 一键导出静态 HTML(zip)。

## 开发启动

```bash
pnpm install
pnpm approve-builds
pnpm dev
```

打开 `http://127.0.0.1:5174/generate`。

## NanoBanana（第三方 multimodal/crawl）配置

复制 `.env.example` 为 `.env.local`，填入：
- `NANOBANANA_3P_AK`
- 可选：`NANOBANANA_3P_BASE_URL`（办公网通常是 `https://genai-sg-og.tiktok-row.org`）
- 可选：`NANOBANANA_3P_LOGID`

未配置或请求失败时会自动回退到本地随机 SVG 生成（仍保证无文字并预留顶部留白）。

## 导出
- 编辑页点击「导出PNG」：走 `Remotion + @remotion/renderer`
- 点击「导出HTML」：生成 `index.html + assets/ + project.json + meta.json` 的 zip
