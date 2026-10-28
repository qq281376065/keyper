/** 六类型值区渲染 + 行右键菜单 + string 编辑 + 深度交互回归 */
module.exports = async function ({ evaluate, wait }) {
  const log = (...a) => console.log(...a)

  // 等待连接就绪
  for (let i = 0; i < 30; i++) {
    const n = await evaluate("document.querySelectorAll('.conn-item').length")
    if (n > 0) break
    await wait(400)
  }
  await evaluate("document.querySelectorAll('.conn-item')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))")
  for (let i = 0; i < 40; i++) {
    const foot = await evaluate("(document.querySelector('.list-foot')||{}).innerText||''")
    if (foot && foot.match(/已加载 [1-9]/)) break
    await wait(500)
  }
  log('键列表就绪:', await evaluate("(document.querySelector('.list-foot')||{}).innerText||''"))

  // 树形视图：全部键都在 DOM（平铺有虚拟滚动分页，脚本翻页不可靠）
  await evaluate("(function(){var bs=document.querySelectorAll('.view-switch button');if(bs.length)bs[0].click()})()")
  await wait(800)

  const results = []
  const types = ['string', 'hash', 'list', 'set', 'zset', 'stream']
  for (const t of types) {
    const picked = await evaluate(`(function(){
      // 展开全部树节点，让叶子全可见
      var expand=[].slice.call(document.querySelectorAll('.viewbar .mini')).find(function(x){return /全部展开/.test(x.title||'')});
      if(expand)expand.click();
      return 'expanded';
    })()`)
    await wait(600)
    // 在树里找目标类型的叶子节点点击
    await evaluate(`(function(){
      var rows=[].slice.call(document.querySelectorAll('.node-row'));
      for(var i=0;i<rows.length;i++){
        var b=rows[i].querySelector('.type-badge');
        if(b&&b.className.indexOf('type-${t}')>-1){rows[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'}
      }
      return 'not-found';
    })()`)
    // 等待值区真正切换到目标类型（最多 5s）
    for (let w = 0; w < 10; w++) {
      const cur = await evaluate("(document.querySelector('.viewer-head .type-badge')||{}).innerText||''")
      if (cur === t) break
      await wait(500)
    }
    const st = await evaluate(`(function(){
      var head=document.querySelector('.viewer-head .type-badge');
      var tbl=document.querySelector('.pair-table');
      var rows=document.querySelectorAll('.pair-row').length;
      // 该类型的右键菜单
      var menuFired = false;
      var row=document.querySelectorAll('.pair-row')[0];
      if(row){row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));menuFired=true}
      return JSON.stringify({
        type:head?head.innerText:'',
        tbl:!!tbl, rows:rows, menuFired:menuFired,
        menuVisible:false
      });
    })()`)
    const s = JSON.parse(st)
    // 菜单是否真的打开
    const menuVisible = await evaluate("(function(){var m=document.querySelector('.row-menu');return m?m.innerText.slice(0,40):'none'})()")
    // 关闭菜单
    await evaluate("(function(){var m=document.querySelector('.row-menu-mask');if(m)m.click()})()")
    await wait(250)
    const needRows = t !== 'string'
    const ok = picked === 'ok' && s.type === t && (!needRows || s.rows > 0)
    results.push(`${ok ? 'PASS' : 'FAIL'} ${t}: type=${s.type} rows=${s.rows} menu="${String(menuVisible).slice(0, 20)}"`)
    log(results[results.length - 1])
  }

  // string 编辑入口（双击进入编辑态）
  await evaluate("(function(){var items=[].slice.call(document.querySelectorAll('.key-item'));for(var i=0;i<items.length;i++){var b=items[i].querySelector('.type-badge');if(b&&b.className.indexOf('type-string')>-1){items[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'}}return 'none'})()")
  await wait(900)
  await evaluate("(function(){var tb=document.querySelector('.text-block');if(tb){tb.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return 'dbl'}return 'no-text-block'})()")
  await wait(600)
  const editState = await evaluate("(function(){var ta=document.querySelector('.text-edit-area');var d=document.querySelector('.text-edit');return JSON.stringify({editArea:!!ta, draft:d?String(d.value).slice(0,30):''}})()")
  log('string 编辑态:', editState)
  await evaluate("(function(){var c=[].slice.call(document.querySelectorAll('.edit-actions .tool')).find(function(x){return /取消/.test(x.innerText)});if(c)c.click()})()")

  log('\n=== 汇总 ===')
  log(results.join('\n'))
}
