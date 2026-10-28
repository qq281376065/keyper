/** 连接后逐个打开弹窗：版本信息 / 值区各编辑弹窗，检查几何 */
module.exports = async function ({ evaluate, wait }) {
  // 先连接
  for (let i = 0; i < 30; i++) {
    const n = await evaluate("document.querySelectorAll('.conn-item').length")
    if (n > 0) break
    await wait(400)
  }
  await evaluate("document.querySelectorAll('.conn-item')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))")
  // 等键加载
  for (let i = 0; i < 40; i++) {
    const foot = await evaluate("(document.querySelector('.list-foot')||{}).innerText||''")
    if (foot && foot.match(/已加载 [1-9]/)) break
    await wait(500)
  }
  console.log('键列表:', await evaluate("(document.querySelector('.list-foot')||{}).innerText||'(空)'"))

  const report = async (label) => {
    const geo = JSON.parse(await evaluate('JSON.stringify(window.__checkDialogGeometry())'))
    console.log(`\n--- ${label} ---`)
    console.log(JSON.stringify(geo))
  }

  // 版本信息（连接菜单 → 版本信息…）
  await evaluate("(function(){var items=[].slice.call(document.querySelectorAll('.conn-item .more-btn'));if(items.length)items[0].click()})()")
  await wait(500)
  await evaluate("(function(){var m=[].slice.call(document.querySelectorAll('.conn-actions .menu-item'));var b=m.find(function(x){return /版本信息/.test(x.innerText)});if(b)b.click()})()")
  await wait(900)
  await report('版本信息弹窗')
  await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /关闭/.test(x.innerText)});if(b)b.click()}})()")
  await wait(400)

  // 选中一个键后，值操作菜单里的重命名/TTL 弹窗
  await evaluate("(function(){var rows=[].slice.call(document.querySelectorAll('.node-row'));for(var i=0;i<rows.length;i++){if(rows[i].className.indexOf('folder')<0){rows[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));break}}})()")
  await wait(900)
  console.log('值区类型:', await evaluate("(document.querySelector('.viewer-head .type-badge')||{}).innerText||'(未选中)'"))

  // 值操作菜单 → 重命名键
  await evaluate("(function(){var b=document.querySelector('.value-actions .more-btn');if(b)b.click()})()")
  await wait(500)
  await evaluate("(function(){var m=[].slice.call(document.querySelectorAll('.value-actions .menu-item'));var b=m.find(function(x){return /重命名键/.test(x.innerText)});if(b)b.click()})()")
  await wait(700)
  await report('重命名弹窗')
  await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /取消/.test(x.innerText)});if(b)b.click()}})()")
  await wait(300)

  // 值操作菜单 → 设置 TTL
  await evaluate("(function(){var b=document.querySelector('.value-actions .more-btn');if(b)b.click()})()")
  await wait(500)
  await evaluate("(function(){var m=[].slice.call(document.querySelectorAll('.value-actions .menu-item'));var b=m.find(function(x){return /设置 TTL/.test(x.innerText)});if(b)b.click()})()")
  await wait(700)
  await report('TTL 弹窗')
  await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var b=[].slice.call(f.querySelectorAll('button')).find(function(x){return /取消/.test(x.innerText)});if(b)b.click()}})()")
  await wait(300)
}
