/**
 * 像素字体「墨迹形态」差异测量。
 *
 * 上一轮结论：5 个 Geist Pixel 变体的 **advance width 完全一致**（极差 0%），
 * 它们是同一等宽度量的设计变体，不是不同度量族的字体。
 * 所以"换字体"的视觉差异只能来自**字形内部的墨迹分布**
 * （方块 / 网格 / 圆点 / 三角 / 细线），必须按像素覆盖率来量。
 *
 * 做法：逐字符渲染到 canvas，统计非透明像素占比与边缘密度，
 * 对比 5 个变体在同一字号下的差异，判断哪种字号下差异才可辨。
 *
 * 用法：node scripts/measure-pixel-ink.cjs
 */
const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false })
  await win.loadURL(process.env.URL)

  const out = await win.webContents.executeJavaScript(`(async function(){
    var SIZES = [22, 30, 37, 44, 54, 68, 80]
    var FAMILIES = [
      ['Square','Geist Pixel Square'],
      ['Grid','Geist Pixel Grid'],
      ['Circle','Geist Pixel Circle'],
      ['Triangle','Geist Pixel Triangle'],
      ['Line','Geist Pixel Line']
    ]
    var SAMPLE = 'RedisDocter'

    // 等字体就绪
    await document.fonts.ready

    function ink(family, size, text){
      var pad = Math.ceil(size * 0.4)
      var cv = document.createElement('canvas')
      var w = Math.ceil(size * text.length * 0.75) + pad * 2
      var h = Math.ceil(size * 1.6) + pad * 2
      cv.width = w; cv.height = h
      var ctx = cv.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.font = size + 'px "' + family + '"'
      ctx.textBaseline = 'top'
      ctx.fillText(text, pad, pad)

      var d = ctx.getImageData(0, 0, w, h).data
      var on = 0, total = w * h
      // 边缘密度：相邻像素亮度差超过阈值的像素对数量
      var edge = 0
      var lum = new Float32Array(total)
      for (var i = 0; i < total; i++) lum[i] = d[i * 4 + 3] / 255
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var p = y * w + x
          if (lum[p] > 0.35) on++
          var gx = Math.abs(lum[p + 1] - lum[p - 1])
          var gy = Math.abs(lum[p + w] - lum[p - w])
          if (gx > 0.35 || gy > 0.35) edge++
        }
      }
      return { coverage: +(on / total).toFixed(4), edgeDensity: +(edge / total).toFixed(4), onPixels: on }
    }

    var rows = []
    SIZES.forEach(function(size){
      var vals = FAMILIES.map(function(f){ return ink(f[1], size, SAMPLE) })
      var covs = vals.map(function(v){ return v.coverage })
      var minC = Math.min.apply(null, covs), maxC = Math.max.apply(null, covs)
      var covSpread = minC > 0 ? +(((maxC - minC) / minC) * 100).toFixed(1) : 0
      rows.push({
        size: size,
        names: FAMILIES.map(function(f){ return f[0] }),
        coverage: covs,
        onPixels: vals.map(function(v){ return v.onPixels }),
        edgeDensity: vals.map(function(v){ return v.edgeDensity }),
        coverageSpreadPct: covSpread
      })
    })
    return JSON.stringify(rows)
  })()`)

  const rows = JSON.parse(out)
  console.log('像素字体「墨迹覆盖率」对比（同一文本 RedisDocter）\n')
  console.log('字号  | ' + rows[0].names.map((n) => n.padStart(9)).join(' ') + ' |  极差%')
  console.log(''.padEnd(76, '-'))
  for (const r of rows) {
    console.log(
      String(r.size).padStart(3) + 'px | ' +
      r.coverage.map((v) => (v * 100).toFixed(2).padStart(8) + '%').join(' ') +
      ' | ' + String(r.coverageSpreadPct).padStart(5) + '%',
    )
  }
  console.log('\n边缘密度（结构复杂度，越高说明笔画越碎）')
  console.log('字号  | ' + rows[0].names.map((n) => n.padStart(9)).join(' '))
  console.log(''.padEnd(72, '-'))
  for (const r of rows) {
    console.log(
      String(r.size).padStart(3) + 'px | ' +
      r.edgeDensity.map((v) => (v * 100).toFixed(2).padStart(8) + '%').join(' '),
    )
  }

  app.exit(0)
})

setTimeout(() => {
  console.log('TIMEOUT')
  app.exit(1)
}, 40000)
