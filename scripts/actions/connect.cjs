/** 连接第一个连接项，等待键列表与值区就绪 */
module.exports = async function ({ evaluate, wait }) {
  console.log('等待首屏...')
  for (let i = 0; i < 30; i++) {
    const n = await evaluate("document.querySelectorAll('.conn-item').length")
    if (n > 0) break
    await wait(400)
  }
  console.log('连接项:', await evaluate("document.querySelectorAll('.conn-item').length"))
  console.log('点击第一个连接...')
  await evaluate("document.querySelectorAll('.conn-item')[0].dispatchEvent(new MouseEvent('click',{bubbles:true}))")
  for (let i = 0; i < 30; i++) {
    const keys = await evaluate("(document.querySelector('.list-foot')||{}).innerText||''")
    if (keys && !keys.includes('扫描中') && keys.match(/已加载 [1-9]/)) break
    await wait(500)
  }
  console.log('键列表状态:', await evaluate("(document.querySelector('.list-foot')||{}).innerText||'(空)'"))
  // 点一个叶子键看值区
  await evaluate("(function(){var rows=[].slice.call(document.querySelectorAll('.node-row'));for(var i=0;i<rows.length;i++){if(rows[i].className.indexOf('folder')<0){rows[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));return 'ok'}}return 'none'})()")
  await wait(1500)
}
