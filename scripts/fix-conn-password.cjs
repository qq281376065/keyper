/**
 * 通过 UI 给第 N 个连接重设密码，使多标签验证可复现。
 * 用法：node scripts/fix-conn-password.cjs 9231 <index> <password>
 */
const http = require('node:http')

const PORT = Number(process.argv[2]) || 9231
const IDX = Number(process.argv[3]) || 2
const PWD = process.argv[4] || ''

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

async function main() {
  const targets = await getJson('/json/list')
  const pg = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools'))
  const ws = new WebSocket(pg.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const ev = (expression) =>
    new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const r = pending.get(m.id)
      pending.delete(m.id)
      r(m.result?.result?.value)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))

  /* 1. 打开第 IDX 项的更多菜单 → 编辑 */
  console.log(
    '菜单项:',
    await ev(`(() => {
      const it = document.querySelectorAll('.conn-item')[${IDX}]
      it.querySelector('.more-btn').click()
      return 'opened'
    })()`),
  )
  await wait(600)
  console.log(
    '点编辑:',
    await ev(`(() => {
      const items = [...document.querySelectorAll('.conn-actions .menu-item, .menu .menu-item')]
      const ed = items.find((x) => /编辑/.test(x.innerText))
      if (!ed) return 'no-edit:' + items.map((x) => x.innerText.trim()).join('|')
      ed.click()
      return 'edit-clicked'
    })()`),
  )
  await wait(1200)

  /* 2. 填密码 */
  console.log(
    '填密码:',
    await ev(`(() => {
      const dlg = document.querySelector('.mask, .dialog-mask, .s-connection-dialog')
      if (!dlg) return 'no-dialog'
      const inputs = [...document.querySelectorAll('input')]
      const pw = inputs.find((i) => i.type === 'password' || /密码/.test(i.placeholder || ''))
      if (!pw) return 'no-pw-input: ' + inputs.map((i) => i.type + '/' + (i.placeholder || '')).join(',')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(pw, ${JSON.stringify(PWD)})
      pw.dispatchEvent(new Event('input', { bubbles: true }))
      pw.dispatchEvent(new Event('change', { bubbles: true }))
      return 'filled'
    })()`),
  )
  await wait(400)

  /* 3. 保存 */
  console.log(
    '保存:',
    await ev(`(() => {
      const foot = document.querySelector('.dialog-foot, .dlg-foot')
      if (!foot) return 'no-foot'
      const btns = [...foot.querySelectorAll('button')]
      const save = btns.find((b) => /保存|确定|连接/.test(b.innerText))
      if (!save) return 'no-save:' + btns.map((b) => b.innerText.trim()).join('|')
      save.click()
      return 'saved'
    })()`),
  )
  await wait(1500)

  console.log('弹窗残留:', await ev("document.querySelectorAll('.s-connection-dialog').length"))
  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.log('ERROR', e.message)
  process.exit(1)
})
