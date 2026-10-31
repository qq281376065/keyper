/**
 * README 截图脚本（演示数据版）
 *
 * 数据源：`npm run dev:web` 启起的浏览器预览（数据全部来自 src/api/mock.ts），
 * 因此截图里不会出现任何真实环境的 IP、账号、业务键名 —— 从源头避免泄露，
 * 而不是靠后期打码。
 *
 * 用法：
 *   1) npm run dev:web -- --port 5200    # 另开一个终端
 *   2) node scripts/shots-readme.cjs 5200
 */
const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const PORT = process.argv[2] || '5200'
const OUT = path.resolve(__dirname, '../docs/screenshots')
const BASE = `http://127.0.0.1:${PORT}`

/** 视口按应用默认窗口（1440×900）设置，比例与真实运行一致 */
const VIEWPORT = { width: 1440, height: 900 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })

  /** 切换主题 → 等稳定 → 截图 */
  async function shot(name, theme = 'dark') {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(700)
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log(`  saved ${name.padEnd(28)} ${theme}`)
  }

  /** 点击文本精确匹配的元素 */
  async function clickText(text, selector = 'button') {
    return page.evaluate(
      ({ text, selector }) => {
        const el = [...document.querySelectorAll(selector)].find(
          (x) => (x.textContent || '').trim() === text,
        )
        if (el) {
          el.click()
          return true
        }
        return false
      },
      { text, selector },
    )
  }

  console.log('→ 主页')
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await sleep(1500)
  for (const th of ['dark', 'light', 'aurora', 'sakura']) await shot(`home-${th}`, th)

  console.log('→ 连接实例')
  // 点第一个演示连接
  await page.evaluate(() => {
    const it = document.querySelector('.conn-item')
    if (it) it.click()
  })
  await sleep(2500)

  console.log('→ CLI 控制台')
  /*
   * 打开 CLI 控制台并执行一条命令，等结果真正回显后再截图。
   *
   * 三个坑（都踩过，别再回头）：
   *
   * 1) 输入方式：必须用 playwright 的 keyboard.type（逐字符真实按键），
   *    不能用「改 DOM value + dispatchEvent('input')」那套。
   *    输入框是 React 受控组件，submit() 读的是 state 里的 input；
   *    直接改 DOM 属性再派发合成事件不会更新 state，
   *    于是 input.trim() 为空、submit() 第一行就 return ——
   *    表现为「点了执行但没有任何输出」，排查了很久。
   *
   * 2) 时序：mock 的 DBSIZE 往返约 2.5s，原实现固定 sleep(1800)
   *    会在结果出来前截图，README 里的 CLI 图只有命令没有结果。
   *
   * 3) 折叠态：面板折叠时 .cli-body 仍是 DOM 节点但 display:none，
   *    对隐藏元素取 innerText 得到空串，判断永远为假。
   *    所以先确认 offsetParent 非空；也不能无条件点 .cli-head ——
   *    若已是展开态，点击反而会收起。
   *
   * 判定用 .cli-log 里的 output entry（结果形如 "1284"），
   * 不要用 .cli-body.innerText —— 它还含输入行，
   * 提示符里的 127.0.0.1:6379 同样是数字，会误判。
   */
  const cliExpanded = await page.evaluate(() => {
    const body = document.querySelector('.cli-body')
    return !!body && body.offsetParent !== null
  })
  if (!cliExpanded) {
    await page.evaluate(() => {
      const h = document.querySelector('.cli-head')
      if (h) h.click()
    })
    await sleep(800)
  }

  /*
   * 提交方式用「点执行按钮」而不是「按 Enter」。
   *
   * Enter 走的是 onKeyDown → submit()，而按钮走 onClick → submit()，
   * 两者本应等价，但实测在长流程后按 Enter 偶发不触发（焦点可能已被
   * 前序操作移走），点按钮更稳。这里选稳的那条路。
   */
  await page.locator('.cli-input-row input').click()
  await page.keyboard.type('DBSIZE', { delay: 40 })
  await sleep(300)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.cli-input-row button')]
    const exec = btns[btns.length - 1]
    if (exec && !exec.disabled) exec.click()
  })

  const cliReady = await page
    .waitForFunction(
      () => {
        const body = document.querySelector('.cli-body')
        if (!body || body.offsetParent === null) return false
        return [...document.querySelectorAll('.cli-log .entry.output')].some((e) =>
          /^\d+/.test(e.innerText.trim()),
        )
      },
      { timeout: 10000 },
    )
    .then(() => true)
    .catch(() => false)
  if (!cliReady) console.log('  ! CLI 结果未在 10s 内出现，仍按当前状态截图')
  await sleep(400)
  await shot('cli-console', 'dark')

  console.log('→ 键浏览器（9 套皮肤）')
  await clickText('树形')
  await sleep(600)
  await clickText('L1')
  await sleep(800)
  for (const th of [
    'dark',
    'light',
    'ocean',
    'solarized',
    'forest',
    'sakura',
    'mint',
    'mist',
    'aurora',
  ]) {
    await shot(`key-browser-${th}`, th)
  }
  await shot('key-browser-tree', 'dark')
  await shot('key-browser-tree-light', 'light')

  console.log('→ 键值查看')
  await clickText('平铺')
  await sleep(1000)
  // 选一个 string 键
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.key-item')]
    const it = items.find((x) => {
      const b = x.querySelector('.type-badge')
      return b && b.textContent.trim() === 'S'
    })
    if (it) it.click()
  })
  await sleep(1800)
  await shot('key-value-string', 'dark')
  await shot('key-value-string-light', 'light')

  // hash
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.key-item')]
    const it = items.find((x) => {
      const b = x.querySelector('.type-badge')
      return b && b.textContent.trim() === 'H'
    })
    if (it) it.click()
  })
  await sleep(1800)
  await shot('key-value-hash', 'dark')
  await shot('key-value-hash-light', 'light')

  // zset（多一层可观性）
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.key-item')]
    const it = items.find((x) => {
      const b = x.querySelector('.type-badge')
      return b && b.textContent.trim() === 'Z'
    })
    if (it) it.click()
  })
  await sleep(1800)
  await shot('key-value-zset', 'dark')

  console.log('→ 全库搜索')
  await page.evaluate(() => {
    const inp = document.querySelector('.filter-box input, .f-input, input[placeholder*=搜索]')
    if (!inp) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'cache')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await sleep(2500)
  await shot('search-result', 'dark')

  // 清空搜索，避免影响后续截图
  await page.evaluate(() => {
    const inp = document.querySelector('.filter-box input, .f-input, input[placeholder*=搜索]')
    if (!inp) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, '')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await sleep(1200)


  console.log('→ 操作日志')
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.bar-btn')]
    if (bs[0]) bs[0].click()
  })
  await sleep(1500)
  await shot('operation-log', 'dark')

  console.log('→ 新建连接弹窗')
  await page.evaluate(() => {
    const h = document.querySelector('.drawer-handle')
    if (h) h.click()
  })
  await sleep(1000)
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent.trim() === '主页',
    )
    if (el) el.click()
  })
  await sleep(1200)
  await page.evaluate(() => {
    const c = document.querySelector('.cta-animate')
    if (c) c.click()
  })
  await sleep(1200)
  await shot('dialog-connection', 'dark')
  await shot('dialog-connection-light', 'light')

  await browser.close()
  console.log('done')
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
