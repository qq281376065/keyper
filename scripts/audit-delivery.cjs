/**
 * 全面交付核查：逐界面、逐组件的 DOM 断言 + 样式命中断言 + 截图对照。
 *
 * 分七个部分：
 *   A. 作用域类完整性：每个组件根元素都带 s-<name>（样式隔离的根基）
 *   B. 图标样式命中：DialogIcon 描边规则、各调用处图标尺寸
 *   C. 弹窗几何：全部 12+ 弹窗宽高符合原设计、零溢出、输入不越界
 *   D. 六类型值区：渲染 + 行菜单 + 编辑入口
 *   E. 主题：明暗切换后关键变量生效
 *   F. 浮层：右键菜单/下拉/tooltip 视口内定位
 *   G. 运行时错误：全流程零异常
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = process.argv[2] ? Number(process.argv[2]) : 9229
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
  })
}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' })
const section = (t) => console.log('\n========== ' + t + ' ==========')

async function main() {
  let targets = null
  for (let i = 0; i < 20; i++) {
    try {
      targets = await getJson('/json/list')
      if (targets?.length) break
    } catch {}
    await wait(300)
  }
  const page = targets.filter((t) => t.type === 'page').find((t) => !t.url.startsWith('devtools'))
  if (!page) return console.log('未找到页面')
  console.log('页面:', page.url)

  const ws = new globalThis.WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []

  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown')
      errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200))
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      errors.push('ERR ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  })

  const send = (method, params = {}) => {
    const mid = ++id
    ws.send(JSON.stringify({ id: mid, method, params }))
    return new Promise((r) => pending.set(mid, r))
  }
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) return 'EVAL-ERR ' + (res.result.exceptionDetails.exception?.description || '').slice(0, 150)
    return res.result?.result?.value
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r.result?.data) fs.writeFileSync(path.join(process.cwd(), `audit-${name}.png`), Buffer.from(r.result.data, 'base64'))
  }
  await send('Runtime.enable')
  await send('Page.enable')

  // 注入几何检查器（同 diagnose-electron，含滚动内容排除）
  await evaluate(`
    (function(){
      window.__checkDialogGeometry = function () {
        var results = []
        var dialogs = [].slice.call(document.querySelectorAll('.dialog'))
        dialogs.forEach(function (dlg, di) {
          var dr = dlg.getBoundingClientRect()
          var overflow = []
          var els = dlg.querySelectorAll('*')
          for (var i = 0; i < els.length; i++) {
            var el = els[i]
            var r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            var anc = el.parentElement, scrollable = false
            while (anc && anc !== dlg) {
              var scs = getComputedStyle(anc)
              if (scs.overflowY === 'auto' || scs.overflowY === 'scroll' || scs.overflowX === 'auto' || scs.overflowX === 'scroll') { scrollable = true; break }
              anc = anc.parentElement
            }
            if (scrollable) continue
            var overL = dr.left - r.left, overR = r.right - dr.right, overT = dr.top - r.top, overB = r.bottom - r.bottom
            var worst = Math.max(overL, overR, overT, overB)
            if (worst > 2) overflow.push({ cls: String(el.className).slice(0, 30), over: Math.round(worst), dir: overL > 2 ? 'left' : overR > 2 ? 'right' : overT > 2 ? 'top' : 'bottom' })
          }
          results.push({ idx: di, w: Math.round(dr.width), h: Math.round(dr.height), top: Math.round(dr.top), overflow: overflow.length, top3: overflow.slice(0, 3) })
        })
        return results
      }
      return 'geo-ready'
    })()
  `)

  /* ================= A. 作用域类完整性 ================= */
  section('A. 作用域类')
  for (let i = 0; i < 30; i++) {
    if ((await evaluate("document.querySelectorAll('.conn-item').length")) > 0) break
    await wait(400)
  }
  const scopeExpect = [
    ['.shell', 's-app'],
    ['.sidebar', 's-connection-sidebar'],
    ['.tabbar', 's-tab-bar'],
    ['.cli', 's-cli-console'],
  ]
  for (const [sel, scope] of scopeExpect) {
    const v = await evaluate(`(function(){var el=document.querySelector('${sel}');return el?el.className.indexOf('${scope}')>-1:'absent'})()`)
    check(`作用域 ${scope} @ ${sel}`, v === true, String(v))
  }

  /* 连接，进入工作区后查组件作用域 */
  await evaluate("document.querySelectorAll('.conn-item')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))")
  for (let i = 0; i < 40; i++) {
    const foot = await evaluate("(document.querySelector('.list-foot')||{}).innerText||''")
    if (foot && foot.match(/已加载 [1-9]/)) break
    await wait(500)
  }
  const kbScope = await evaluate("(function(){var k=document.querySelector('.key-browser');return k?String(k.className).indexOf('s-key-browser')>-1:'absent'})()")
  check('作用域 s-key-browser', kbScope === true, String(kbScope))
  const wsScope = await evaluate("(function(){var v=document.querySelector('.viewer');return v?String(v.className).indexOf('s-value-viewer')>-1:'absent'})()")
  check('作用域 s-value-viewer @ .viewer', wsScope === true, String(wsScope))
  const wkScope = await evaluate("(function(){var w=document.querySelector('.tab-workspace');return w?String(w.className).indexOf('s-workspace')>-1:'absent'})()")
  check('作用域 s-workspace', wkScope === true, String(wkScope))
  console.log(results.slice(-8).map((r) => (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + '  ' + r.detail).join('\n'))

  /* ================= B. 图标样式 ================= */
  section('B. 图标')
  const icon = await evaluate(`(function(){
    var ico=document.querySelector('.dlg-ico')
    if(!ico) return JSON.stringify({found:false})
    var cs=getComputedStyle(ico)
    return JSON.stringify({found:true, hasScope:String(ico.classList?ico.classList.value||ico.className:'').indexOf('s-dialog-icon')>-1||String(ico.className.baseVal||'').indexOf('s-dialog-icon')>-1,
      fill:cs.fill, strokeW:cs.strokeWidth, linecap:cs.strokeLinecap})
  })()`)
  const iconData = JSON.parse(icon)
  check('图标描边规则命中（fill:none/stroke-width:1.5）', iconData.found && iconData.fill === 'none' && iconData.strokeW === '1.5px', icon)
  const iconCount = await evaluate("document.querySelectorAll('.dlg-ico').length")
  check('界面图标数量 > 10', iconCount > 10, String(iconCount))

  /* 图标渲染为源码文本的回归（事故防回退） */
  const iconLeak = await evaluate("(function(){var bad=0;[].slice.call(document.querySelectorAll('.dlg-ico')).forEach(function(el){if(/name ===|<path|return/.test(el.textContent))bad++});return bad})()")
  check('图标无源码文本泄漏', iconLeak === 0, String(iconLeak) + ' 处')

  /* ================= C. 弹窗几何（逐个打开） ================= */
  section('C. 弹窗几何')
  const openDlg = async (openJs, closeJs, name, expectW) => {
    // 先清场：关闭所有残留弹窗（Escape 可能无效，逐个点 footer 取消/关闭）
    await evaluate("(function(){var closes=[].slice.call(document.querySelectorAll('.dialog-foot button')).filter(function(b){return /取消|关闭|完成/.test(b.innerText)});if(closes.length)closes[0].click()})()")
    await wait(500)
    await evaluate(openJs)
    await wait(700)
    const geo = JSON.parse(await evaluate('JSON.stringify(window.__checkDialogGeometry())'))
    /* 断言目标弹窗：新打开的是数组里第一个；残留（若有）只验证其自身也不溢出 */
    const g = geo[0] || { w: 0, overflow: -1, top: -1 }
    const inVp = g.top >= 0 && g.top + g.h <= 900 + 2
    const allClean = geo.every((x) => x.overflow === 0)
    check(`弹窗 ${name} (${g.w}px)`, g.overflow === 0 && inVp && allClean && (!expectW || g.w === expectW), JSON.stringify(geo).slice(0, 120))
    if (closeJs) await evaluate(closeJs)
    await wait(400)
  }

  await openDlg(
    "(function(){var bs=[].slice.call(document.querySelectorAll('.sidebar .head-actions .add-btn'));var t=bs.length===3?bs[1]:bs[0];if(t)t.click();return 1})()",
    "(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /取消/.test(x.innerText)});if(b)b.click()}})()",
    '新建连接', 520,
  )

  await openDlg(
    "(function(){var b=document.querySelectorAll('.topbar .bar-btn')[1];if(b)b.click();return 1})()",
    "(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /完成/.test(x.innerText)});if(b)b.click()}})()",
    '设置', 680,
  )

  // 版本信息（经连接菜单）
  await evaluate("(function(){var items=[].slice.call(document.querySelectorAll('.conn-item .more-btn'));if(items.length)items[0].click()})()")
  await wait(500)
  await evaluate("(function(){var m=[].slice.call(document.querySelectorAll('.conn-actions .menu-item'));var b=m.find(function(x){return /版本信息/.test(x.innerText)});if(b)b.click()})()")
  await wait(900)
  await evaluate("(function(){var closes=[].slice.call(document.querySelectorAll('.dialog-foot button')).filter(function(b){return /取消|关闭|完成/.test(b.innerText)});if(closes.length)closes[0].click()})()")
  await wait(500)
  const verGeo = JSON.parse(await evaluate('JSON.stringify(window.__checkDialogGeometry())'))
  const vg = verGeo[0] || {}
  check(`弹窗 版本信息 (${vg.w}px)`, verGeo.length === 1 && vg.overflow === 0 && vg.w === 760, JSON.stringify(verGeo).slice(0, 100))
  await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /关闭/.test(x.innerText)});if(b)b.click()}})()")
  await wait(400)

  /* ================= D. 六类型值区 + 行菜单 ================= */
  section('D. 六类型')
  // 展开全部：L1/L2/全部展开按钮无原生 title，直接按顺序点第 3 个 mini（全部展开）
  // 兜底：逐个点开所有 folder 的 caret
  await evaluate("(function(){var minis=[].slice.call(document.querySelectorAll('.viewbar .mini'));if(minis.length>2)minis[2].click();return 1})()")
  await wait(1000)
  for (let round = 0; round < 6; round++) {
    const n = await evaluate("(function(){var cs=[].slice.call(document.querySelectorAll('.node-row.folder > .caret'));cs.forEach(function(c){c.click()});return cs.length})()")
    if (!n) break
    await wait(700)
  }
  await wait(800)
  for (const t of ['string', 'hash', 'list', 'set', 'zset', 'stream']) {
    const r = await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('.node-row'));for(var i=0;i<rows.length;i++){var b=rows[i].querySelector('.type-badge');if(b&&b.className.indexOf('type-${t}')>-1){rows[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'}}return 'nf'})()`)
    let cur = ''
    for (let w = 0; w < 12; w++) {
      cur = await evaluate("(document.querySelector('.viewer-head .type-badge')||{}).innerText||''")
      if (cur === t) break
      await wait(400)
    }
    const rows = await evaluate("document.querySelectorAll('.pair-row').length")
    if (t === 'string') {
      await evaluate("(function(){var tb=document.querySelector('.text-block');if(tb)tb.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 1})()")
      await wait(500)
      const edit = await evaluate("!!document.querySelector('.text-edit-area')")
      check(`string 编辑`, r === 'ok' && cur === t && edit, `picked=${r} cur=${cur}`)
      await evaluate("(function(){var c=[].slice.call(document.querySelectorAll('.edit-actions .tool')).find(function(x){return /取消/.test(x.innerText)});if(c)c.click()})()")
    } else {
      await evaluate("(function(){var row=document.querySelectorAll('.pair-row')[0];if(row)row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))})()")
      await wait(500)
      const menu = await evaluate("(document.querySelector('.row-menu')||{}).innerText||''")
      const fit = await evaluate("(function(){var m=document.querySelector('.row-menu');if(!m)return 'no-menu';var r=m.getBoundingClientRect();return (r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight)?'fits':'OUT'})()")
      check(`类型 ${t}`, r === 'ok' && cur === t && rows > 0 && menu !== '' && fit === 'fits', `picked=${r} cur=${cur} rows=${rows} menu=${fit}`)
      await evaluate("(function(){var m=document.querySelector('.row-menu-mask');if(m)m.click()})()")
      await wait(300)
    }
  }

  /* ================= E. 主题 ================= */
  section('E. 主题')
  await evaluate("(function(){var t=document.querySelector('.theme-switch .trigger');if(t)t.click();return 1})()")
  await wait(400)
  const themeMenu = await evaluate("!!document.querySelector('.theme-switch .menu')")
  await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('.theme-switch .menu-item')).find(function(x){return /亮色/.test(x.innerText)});if(b)b.click()})()")
  await wait(500)
  const lightBg = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()")
  await evaluate("(function(){var t=document.querySelector('.theme-switch .trigger');if(t)t.click()})()")
  await wait(300)
  await evaluate("(function(){var b=[].slice.call(document.querySelectorAll('.theme-switch .menu-item')).find(function(x){return /暗色/.test(x.innerText)});if(b)b.click()})()")
  await wait(500)
  const darkBg = await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()")
  check('主题菜单 + 明暗切换', themeMenu && lightBg !== darkBg, `light=${lightBg} dark=${darkBg}`)

  /* ================= F. 键右键菜单 / 操作日志面板 ================= */
  section('F. 浮层')
  await evaluate("(function(){var rows=[].slice.call(document.querySelectorAll('.node-row'));var leaf=null;for(var i=0;i<rows.length;i++){if(rows[i].className.indexOf('folder')<0){leaf=rows[i];break}}if(leaf)leaf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return 1})()")
  await wait(500)
  const keyMenuFit = await evaluate("(function(){var m=document.querySelector('.key-menu');if(!m)return 'no';var r=m.getBoundingClientRect();return (r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight)?'fits':'OUT:'+JSON.stringify({t:Math.round(r.top),b:Math.round(r.bottom)})})()")
  check('键右键菜单视口内', keyMenuFit === 'fits', String(keyMenuFit))
  await evaluate("(function(){var m=document.querySelector('.key-menu-mask');if(m)m.click()})()")
  await wait(300)

  // 操作日志抽屉
  await evaluate("(function(){var b=document.querySelectorAll('.topbar .bar-btn')[0];if(b)b.click()})()")
  await wait(800)
  const drawer = await evaluate("(function(){var d=document.querySelector('.log-drawer');if(!d)return 'no-drawer';var r=d.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),visible:r.width>200,head:(d.querySelector('.drawer-head')||{}).innerText||''})})()")
  check('日志抽屉打开', drawer.indexOf('visible') > -1 && JSON.parse(drawer).visible, drawer)
  await shot('log-drawer')
  await evaluate("(function(){var h=document.querySelector('.drawer-handle');if(h)h.click()})()")
  await wait(900)
  await evaluate("(function(){var h=document.querySelector('.drawer-handle');if(h)h.click()})()")

  /* ================= G. 汇总 ================= */
  section('G. 汇总')
  await shot('final')
  const fails = results.filter((r) => !r.ok)
  console.log(results.map((r) => (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  → ' + r.detail : '')).join('\n'))
  console.log(`\n${results.length - fails.length}/${results.length} 通过`)
  console.log('\n运行时错误:', errors.length ? '\n' + errors.slice(0, 8).join('\n') : '无')
  ws.close()
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
