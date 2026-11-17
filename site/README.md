# Keyper 开源站点

纯静态站点，没有构建步骤：`index.html` + `assets/` 就是全部产物，直接交给 GitHub Pages 托管。

## 本地预览

```
node scripts/serve-site.mjs 4321     # → http://127.0.0.1:4321/
```

## 校验

```
node scripts/site-check.mjs
```

检查中英词条一一对应、图片引用存在且没有孤儿截图、HTML 标签闭合、历史项目名没有出现在页面或英文词条里。发布工作流在上传产物前执行同一条命令，检查不过就不发布。

## 双语怎么维护

- 中文直接写在 `index.html` 里，需要翻译的节点标 `data-i18n`（纯文本）、`data-i18n-html`（含标签）、`data-i18n-aria`（无障碍标签）。
- 英文写在 `assets/i18n.js` 的 `window.KEYPER_EN`，key 与 HTML 上的完全一致。加载时先把中文快照下来，切换语言就是两份字典互换。
- 首次访问按 `navigator.language` 选语言，用户手动切换后记在 `localStorage`（`keyper.site.lang`）；深浅主题同理（`keyper.site.theme`）。
- 新增文案时忘了配英文，`site-check.mjs` 会直接报 missing。

## 截图

`assets/screenshots/` 是 `docs/screenshots/` 的副本，画面全部来自应用内置的演示数据，不含真实主机、账号或密钥。界面有新截图时：复制文件进站点目录，在 gallery 区块加一张卡片（`data-full` 指向大图，`figcaption` 作为说明与 alt 文本），灯箱会自动把当前可见的截图纳入翻页序列。

## 发布

推送到 `main` 且 `site/**` 或工作流本身发生变化时，`.github/workflows/site.yml` 把整个目录上传为 Pages 产物并部署。第一次启用需要在仓库 **Settings → Pages** 把 Source 设为 **GitHub Actions**。

## 约定

- 页面不写具体版本号与发布日期：逐版说明、下载物以 GitHub Releases 为准，这样发新版本后这一页不会过期。
- 站点只以 Keyper 呈现，不出现历史项目名。
- 不出现真实连接信息；示例值统一标注为演示数据。
