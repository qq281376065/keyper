/** 逐个打开全部弹窗，检查几何错位（子元素溢出弹窗边界） */
module.exports = async function ({ evaluate, wait }) {
  const step = async (label, fn) => {
    const before = await evaluate('JSON.stringify(window.__checkDialogGeometry())')
    const open = await evaluate(fn)
    await wait(700)
    const geo = JSON.parse(await evaluate('JSON.stringify(window.__checkDialogGeometry())'))
    console.log(`\n--- ${label} (${open}) ---`)
    console.log(JSON.stringify(geo))
    await evaluate("document.querySelector('.mask') && document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); [].slice.call(document.querySelectorAll('.mask .btn, .mask button')).forEach(function(b){}); ")
    // 关闭：优先点弹窗 footer 的取消/关闭按钮
    await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var bs=[].slice.call(f.querySelectorAll('button'));var b=bs.find(function(x){return /取消|关闭|完成/.test(x.innerText)});if(b){b.click();return 'closed-btn'}}var h=document.querySelector('.dialog-head');if(h){var b=h.querySelector('button');if(b){b.click();return 'closed-head'}}return 'no-dialog'})()")
    await wait(500)
    void before
  }

  // 1. 新建连接
  await step('新建连接弹窗', "(function(){var bs=[].slice.call(document.querySelectorAll('.sidebar .head-actions .add-btn'));var t=bs.length===3?bs[1]:bs[0];if(t){t.click();return 'ok'}return 'no-btn'})()")

  // 2. 设置
  await step('设置弹窗', "(function(){var b=document.querySelectorAll('.topbar .bar-btn')[1];if(b){b.click();return 'ok'}return 'no-btn'})()")

  // 3. 主题菜单（浮层）
  await step('主题菜单', "(function(){var t=document.querySelector('.theme-switch .trigger');if(t){t.click();return 'ok'}return 'no-btn'})()")

  // 4. 版本信息（需先连接）
  await step('版本信息弹窗', "(function(){var items=[].slice.call(document.querySelectorAll('.conn-item .more-btn'));if(items.length){items[0].click();return 'menu-open'}return 'no-item'})()")
  await wait(500)
  // 菜单里点版本信息
  await evaluate("(function(){var m=[].slice.call(document.querySelectorAll('.conn-actions .menu-item'));var b=m.find(function(x){return /版本信息/.test(x.innerText)});if(b){b.click();return 'version-open'}return 'menu:'+(m.length)+'items'})()")
  await wait(800)
  const versionGeo = JSON.parse(await evaluate('JSON.stringify(window.__checkDialogGeometry())'))
  console.log('\n--- 版本信息弹窗 ---')
  console.log(JSON.stringify(versionGeo))
  await evaluate("(function(){var f=document.querySelector('.dialog-foot');if(f){var bs=[].slice.call(f.querySelectorAll('button'));var b=bs.find(function(x){return /关闭/.test(x.innerText)});if(b){b.click();return 'closed'}}return 'none'})()")
  await wait(500)

  // 5. 键右键菜单（树形右键）
  const menuGeo = await evaluate("(function(){var rows=[].slice.call(document.querySelectorAll('.node-row'));var leaf=null;for(var i=0;i<rows.length;i++){if(rows[i].className.indexOf('folder')<0){leaf=rows[i];break}}if(!leaf)return 'no-leaf';leaf.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return 'menu-fired'})()")
  await wait(600)
  const km = await evaluate('JSON.stringify({mask:!!document.querySelector(".key-menu-mask"), menu:!!document.querySelector(".key-menu"), inViewport:(function(){var m=document.querySelector(".key-menu");if(!m)return null;var r=m.getBoundingClientRect();return {t:Math.round(r.top),l:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height),fits:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}})()})')
  console.log('\n--- 键右键菜单 (' + menuGeo + ') ---')
  console.log(km)
  await evaluate("document.querySelector('.key-menu-mask') && document.querySelector('.key-menu-mask').click()")
  await wait(300)

  // 6. CLI 执行
  await evaluate("(function(){var h=document.querySelector('.cli-head');if(h){h.click();return 'cli-toggled'}})()")
  await wait(400)
}
