/**
 * README 补充截图：右侧服务端信息面板的四个页签。
 *
 * 与 shots-readme.cjs 分开写，是为了不把它已经跑通的一整套流程改动风险化 ——
 * 那里覆盖主页/键浏览器/键值/搜索/CLI/日志/弹窗，这里只补本轮新增的
 * 「Redis 信息详情 / 慢查询 / 键内存分析 / Pub-Sub」四个页签。
 *
 * 数据源同为 dev:web 的 mock，不含真实 IP 与业务键名。
 *
 * 用法：node scripts/shots-overview.cjs 5201
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const PORT = process.argv[2] || '5200'
const OUT = path.resolve(__dirname, '../docs/screenshots')
const BASE = `http://127.0.0.1:${PORT}`
const VIEWPORT = { width: 1440, height: 900 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  async function shot(name, theme) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(700)
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log(`  saved ${name.padEnd(28)} ${theme}`)
  }

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await sleep(1600)

  // 连一个演示实例
  await page.evaluate(() => {
    const it = document.querySelector('.conn-item')
    if (it) it.click()
  })
  await sleep(3000)

  /** 按文本点页签 —— 四个页签固定，不依赖索引顺序 */
  async function openTab(label) {
    const ok = await page.evaluate((text) => {
      const t = [...document.querySelectorAll('.ov-tab')].find((x) => x.textContent.includes(text))
      if (t) {
        t.click()
        return true
      }
      return false
    }, label)
    await sleep(1400)
    return ok
  }

  console.log('→ 右侧信息面板')
  if (!(await openTab('信息详情'))) {
    console.log('  ! 未找到 .ov-tab，跳过')
    await browser.close()
    return
  }
  await shot('overview-info', 'dark')
  await shot('overview-info-light', 'light')

  if (await openTab('慢查询')) await shot('overview-slowlog', 'dark')

  if (await openTab('内存')) {
    /*
     * 必须真的点一次「开始分析」。
     * 内存分析是显式触发的（逐键探测开销大，不做自动扫描），
     * 不点就只会截到"点击开始分析统计…"的空态 —— 那等于没展示这个功能。
     */
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始分析')
      if (b) b.click()
    })
    await sleep(7000)
    await shot('overview-memory', 'dark')
  }

  if (await openTab('Pub/Sub')) {
    // 订阅一个演示频道，让「已订阅清单」的 chip 出现在截图里
    await page.evaluate(() => {
      const inp = document.querySelector('.ps-input')
      if (!inp) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, 'demo:notice')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await sleep(500)
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '订阅')
      if (b) b.click()
    })
    await sleep(2200)
    await shot('overview-pubsub', 'dark')
  }

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
