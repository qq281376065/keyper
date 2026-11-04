/**
 * 弹窗 / 按钮内的前置图标（语义命名，全部内联 SVG）。
 *
 * 为什么做成组件而不是各处内联 SVG：
 * 同一套图标要出现在十几个弹窗的按钮里，
 * 内联会把上百行重复的路径数据散落到各文件，改一处颜色/粗细要改几十处。
 *
 * 图标按**语义**命名而非形状（如 `save` 而非 `floppy`）：
 * 调用方关心的是"这个按钮在做什么"，形状调整时不必回头改所有调用。
 *
 * 统一规格：16×16 viewBox、`stroke: currentColor`（跟随按钮文字色）、
 * 1.5 的描边宽度（比表格行内图标略粗，因为弹窗按钮字号更大）。
 */
export type DialogIconName =
  | 'cancel'
  | 'save'
  | 'close'
  | 'check'
  | 'test'
  | 'copy'
  | 'add'
  | 'edit'
  | 'trash'
    /* 以下为右键菜单使用 */
  | 'eye'
  | 'terminal'
  | 'clock'
  | 'folder'
  | 'text'
  | 'star'
    /* 以下为服务端概览卡片使用 */
  | 'server'
  | 'memory'
  | 'activity'
  | 'document'
    /* 以下为批量删除面板按钮使用 */
  | 'stop'
    /* 以下为按钮图标全覆盖改造新增 */
  | 'refresh'
  | 'tree'
  | 'list'
  | 'expand'
  | 'collapse'
  | 'clear'
  | 'play'
  | 'bolt'
  | 'power'
  | 'clone'
  | 'link'
  | 'menu'
  | 'folder-open'
  | 'import'
  | 'export'
  | 'search'
  | 'warning'
  | 'info'
  | 'settings'
  | 'theme'
  | 'reset'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'sun'
  | 'moon'
  | 'hamburger'
  | 'sliders'
    /* 连接栏收起 / 展开 */
  | 'sidebar-collapse'
  | 'sidebar-expand'
    /* 皮肤即主题：深海 / 暖纸 / 墨林 / 樱花 / 薄荷 / 雾蓝 */
  | 'ocean'
  | 'solarized'
  | 'forest'
  | 'sakura'
  | 'mint'
  | 'mist'
  | 'aurora'
    /* 密码可见性切换：闭眼 */
  | 'eye-off'
    /* 连接项「更多操作」：实心三点（比描线 menu 更醒目） */
  | 'more'
    /* 连接列表置顶：图钉 */
  | 'pin'
    /* 自绘标题栏的窗口控制 */
  | 'win-min'
  | 'win-max'
  | 'win-restore'
    /* 多标签：固定主页标签 */
  | 'home'
    /* 多标签溢出：左右箭头滚动 */
  | 'chevron-left'
  | 'chevron-right'
    /* 语言切换：地球（经线 + 纬线） */
  | 'globe'
    /* 概览监控页签：折线坐标轴 / 键空间通知：铃铛 */
  | 'chart'
  | 'bell'
    /* 值格式菜单：JWT / 编码转换 / PHP / 压缩包 / 二进制 */
  | 'key'
  | 'convert'
  | 'code'
  | 'archive'
  | 'binary'
    /* 连接栏顶部「导入 / 导出连接」入口：单托盘 + 双向箭头 */
  | 'transfer'
  /** 尺寸（px），默认 13 */

export interface DialogIconProps {
  name: DialogIconName
  /** 尺寸（px），默认 13 */
  size?: number
  /** 额外类名（用于颜色 / 旋转等局部修饰） */
  className?: string
}

/** 图标查找：逐条 if + return（理由见文件头注释） */
function renderGlyph(name: DialogIconName): React.ReactElement | null {
  /** 取消：叉号。
      端点取 3.2~12.8 而非更常见的 4~12 ——
      在 13px 这种小尺寸下，4~12 的叉号只剩约 6.5px 的可视笔画，
      放在带文字的按钮里会显得比文字小一圈、像是"没显示出来"。 */
  if (name === 'cancel') {
    return (
      <g>
        <path d="M3.6 3.6 12.4 12.4M12.4 3.6 3.6 12.4" />
      </g>
    )
  }
  /** 关闭：箭头指向外侧（表达"离开"而非"否决"） */
  if (name === 'close') {
    return (
      <g>
        <path d="M6.5 3.5h-2A1.5 1.5 0 0 0 3 5v6a1.5 1.5 0 0 0 1.5 1.5h2" />
        <path d="M9.5 5.5 13 8l-3.5 2.5" />
        <path d="M13 8H6.5" />
      </g>
    )
  }
  /** 主页：小房子（多标签的固定主页标签） */
  if (name === 'home') {
    return (
      <g>
        <path d="M2.8 7.6 8 3l5.2 4.6v4.9a.5.5 0 0 1-.5.5H3.3a.5.5 0 0 1-.5-.5Z" />
        <path d="M6.4 13V9.6h3.2V13" />
      </g>
    )
  }
  /** 保存：软盘 */
  if (name === 'save') {
    return (
      <g>
        <path d="M3 3h7.2L13 5.8V13a0 0 0 0 1 0 0H3z" />
        <path d="M5.5 3v3.2h4V3" />
        <path d="M5.5 9.2h5V13h-5z" />
      </g>
    )
  }
  /** 确认：对勾 */
  if (name === 'check') {
    return (
      <g>
        <path d="M3.2 8.4 6.4 11.6 12.8 5.2" />
      </g>
    )
  }
  /** 测试：闪电 */
  if (name === 'test') {
    return (
      <g>
        <path d="M8.8 2 4 8.8h3.4L7.2 14 12 7.2H8.6z" />
      </g>
    )
  }
  /** 复制：双矩形（与表格行内图标同款） */
  if (name === 'copy') {
    return (
      <g>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
      </g>
    )
  }
  /** 新增：加号 */
  if (name === 'add') {
    return (
      <g>
        <path d="M8 3.5v9M3.5 8h9" />
      </g>
    )
  }
  /** 编辑：铅笔 */
  if (name === 'edit') {
    return (
      <g>
        <path d="M11.2 2.6a1.6 1.6 0 0 1 2.2 2.2l-6.6 6.6-2.9.7.7-2.9z" />
      </g>
    )
  }
  /** 删除：垃圾桶 */
  if (name === 'trash') {
    return (
      <g>
        <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" />
      </g>
    )
  }
  /** 中止：停止方块（术语上比 × 更准确，× 容易被读成"关闭面板"） */
  if (name === 'stop') {
    return (
      <g>
        <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.4" />
      </g>
    )
  }
  /** 查看值：眼睛 */
  if (name === 'eye') {
    return (
      <g>
        <path d="M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z" />
        <circle cx="8" cy="8" r="2.1" />
      </g>
    )
  }
  /** 隐藏密码：闭眼。与 eye 相同的上下眼睑弧线，但左右断开、
      瞳孔挖空被斜杠取代 —— 斜杠是"禁止/关闭"的通用语汇，
      13px 尺寸下辨识度远高于"眯起的眼缝"。 */
  if (name === 'eye-off') {
    return (
      <g>
        <path d="M3 5.2C2.1 6.1 1.6 8 1.6 8s2.4 4.4 6.4 4.4c1 0 1.9-.24 2.7-.62" />
        <path d="M13 10.8c.8-.9 1.4-2.8 1.4-2.8s-2.4-4.4-6.4-4.4c-.7 0-1.3.1-1.9.28" />
        <path d="M2.4 13.6 13.6 2.4" />
      </g>
    )
  }
  /** 命令：终端提示符 */
  if (name === 'terminal') {
    return (
      <g>
        <rect x="1.8" y="3" width="12.4" height="10" rx="1.5" />
        <path d="M4.6 6.6 6.8 8.4 4.6 10.2M8.4 10.6h3.2" />
      </g>
    )
  }
  /** TTL：时钟 */
  if (name === 'clock') {
    return (
      <g>
        <circle cx="8" cy="8" r="5.6" />
        <path d="M8 4.8V8l2.2 1.6" />
      </g>
    )
  }
  /** 前缀/目录：文件夹 */
  if (name === 'folder') {
    return (
      <g>
        <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h2.6l1.3 1.5h5.1c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
      </g>
    )
  }
  /** 复制键名：文字行 */
  if (name === 'text') {
    return (
      <g>
        <path d="M3 4h10M3 7.4h6.4M3 10.8h8" />
      </g>
    )
  }
  /** 服务器：机架主机（两条盘位 + 指示灯） */
  if (name === 'server') {
    return (
      <g>
        <rect x="2.2" y="2.8" width="11.6" height="4.4" rx="1.2" />
        <rect x="2.2" y="8.8" width="11.6" height="4.4" rx="1.2" />
        <path d="M4.6 5h.01M4.6 11h.01" />
      </g>
    )
  }
  /** 内存：芯片（方框 + 引脚） */
  if (name === 'memory') {
    return (
      <g>
        <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" />
        <path d="M6.4 2.2v1.6M9.6 2.2v1.6M6.4 12.2v1.6M9.6 12.2v1.6M2.2 6.4h1.6M2.2 9.6h1.6M12.2 6.4h1.6M12.2 9.6h1.6" />
      </g>
    )
  }
  /** 状态：活动波形 */
  if (name === 'activity') {
    return (
      <g>
        <path d="M1.6 8h2.6l1.8-4.4 2.4 8.8 1.8-4.4h3.2" />
      </g>
    )
  }
  /** 信息详情：圆形背景 + 感叹号。
      实心圆在 fill:none 的默认规则下不会显示，因此显式给 fill；
      感叹号用背景色描边"挖"出来，样式见 .dlg-ico .knockout。 */
  if (name === 'document') {
    return (
      <g>
        <circle cx="8" cy="8" r="6.2" fill="currentColor" stroke="none" />
        <path className="knockout" d="M8 4.7v4.2M8 11.2v.01" />
      </g>
    )
  }
  /** 刷新 / 重新扫描：环形箭头（缺口在右上，顺时针方向感更强） */
  if (name === 'refresh') {
    return (
      <g>
        <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
        <path d="M13.4 2.8v3.2h-3.2" />
      </g>
    )
  }
  /** 树形视图：根节点 + 两条分支 */
  if (name === 'tree') {
    return (
      <g>
        <rect x="2.4" y="2.2" width="4.2" height="3.2" rx="0.9" />
        <rect x="9.4" y="10.6" width="4.2" height="3.2" rx="0.9" />
        <path d="M4.5 5.4v4.2a1.2 1.2 0 0 0 1.2 1.2h3.7" />
      </g>
    )
  }
  /** 平铺视图：三条等长横线 */
  if (name === 'list') {
    return (
      <g>
        <path d="M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h10.8" />
      </g>
    )
  }
  /** 全部展开：向四角打开的箭头 */
  if (name === 'expand') {
    return (
      <g>
        <path d="M9.6 2.6h3.8v3.8M6.4 13.4H2.6V9.6" />
        <path d="M13.4 2.6 9.2 6.8M2.6 13.4l4.2-4.2" />
      </g>
    )
  }
  /** 全部折叠：向中心收拢的箭头 */
  if (name === 'collapse') {
    return (
      <g>
        <path d="M13.4 6.4H9.6V2.6M2.6 9.6h3.8v3.8" />
        <path d="M9.6 6.4 13.4 2.6M2.6 13.4l3.8-3.8" />
      </g>
    )
  }
  /** 因为"清空日志"清的是展示内容、不是删除持久数据 */
  if (name === 'clear') {
    return (
      <g>
        <path d="M6.6 12.8H3.4a1 1 0 0 1-.7-1.7l6.4-6.4a1 1 0 0 1 1.4 0l2.2 2.2a1 1 0 0 1 0 1.4l-4.6 4.5z" />
        <path d="M7.4 12.8h5.4" />
      </g>
    )
  }
  /** 执行：播放三角 */
  if (name === 'play') {
    return (
      <g>
        <path d="M5.2 3.4v9.2L12.6 8z" />
      </g>
    )
  }
  /** 闪电（测试连接 / 快速操作） */
  if (name === 'bolt') {
    return (
      <g>
        <path d="M8.8 2 4 9h3.4L7.2 14 12 7H8.6z" />
      </g>
    )
  }
  /** 连接 / 断开：电源符号 */
  if (name === 'power') {
    return (
      <g>
        <path d="M8 2.4v5" />
        <path d="M11.6 4.6a5 5 0 1 1-7.2 0" />
      </g>
    )
  }
  /** 克隆：两个叠放的方框，右上角带小箭头方向 */
  if (name === 'clone') {
    return (
      <g>
        <rect x="2.4" y="5.4" width="8.2" height="8.2" rx="1.4" />
        <path d="M5.4 5.4V3.8a1.4 1.4 0 0 1 1.4-1.4h5.4A1.4 1.4 0 0 1 13.6 3.8v5.4a1.4 1.4 0 0 1-1.4 1.4h-1.6" />
      </g>
    )
  }
  /** 链接 / 复制地址：两段相扣的链环 */
  if (name === 'link') {
    return (
      <g>
        <path d="M6.6 9.4a2.4 2.4 0 0 0 3.4 0l3-3a2.4 2.4 0 0 0-3.4-3.4l-1.2 1.2" />
        <path d="M9.4 6.6a2.4 2.4 0 0 0-3.4 0l-3 3a2.4 2.4 0 0 0 3.4 3.4l1.2-1.2" />
      </g>
    )
  }
  /** 更多操作：三个竖点 */
  if (name === 'menu') {
    return (
      <g>
        <path d="M8 3.6v.01M8 8v.01M8 12.4v.01" />
      </g>
    )
  }
  /** 更多操作（加强版）：实心三点。
      menu 的描线点在列表行的弱色文字里几乎看不见（用户反馈"不明显"），
      实心圆 + currentColor 保证任何主题下都有足够对比度。 */
  if (name === 'more') {
    return (
      <g>
        <circle cx="8" cy="3.9" r="1.35" fill="currentColor" stroke="none" />
        <circle cx="8" cy="8" r="1.35" fill="currentColor" stroke="none" />
        <circle cx="8" cy="12.1" r="1.35" fill="currentColor" stroke="none" />
      </g>
    )
  }
  /** 置顶：图钉（thumbtack）。
      顶部短帽 + 收腰的帽身 + 底部宽翼 + 居中针杆 ——
      13px 下靠"上窄下宽 + 竖针"的轮廓即可辨认，
      不必画斜置透视（小尺寸下会糊成一团）。 */
  if (name === 'pin') {
    return (
      <g>
        <path d="M6.2 2.6v2.8L4.4 7.6V9h7.2V7.6L9.8 5.4V2.6H6.2z" />
        <path d="M8 9v4.4" />
      </g>
    )
  }
  /** 窗口最小化：底部横线（自绘标题栏） */
  if (name === 'win-min') {
    return (
      <g>
        <path d="M3.5 12h9" />
      </g>
    )
  }
  /** 窗口最大化：方框 */
  if (name === 'win-max') {
    return (
      <g>
        <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
      </g>
    )
  }
  /** 窗口向下还原：前框 + 后框错位叠放（Windows 惯例形态） */
  if (name === 'win-restore') {
    return (
      <g>
        <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
        <path d="M10.5 5.5V5A1.5 1.5 0 0 0 9 3.5H5A1.5 1.5 0 0 0 3.5 5v4A1.5 1.5 0 0 0 5 10.5h.5" />
      </g>
    )
  }
  /** 打开目录：文件夹 + 向外箭头 */
  if (name === 'folder-open') {
    return (
      <g>
        <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h2.6l1.3 1.5h5.1c.7 0 1.2.5 1.2 1.2v1H1.8z" />
        <path d="M1.8 6.7h12.4l-1.2 4.8c-.1.5-.6.9-1.1.9H4.1c-.5 0-1-.4-1.1-.9z" />
      </g>
    )
  }
  /** 导入：向下的箭头落进托盘（从外部读入） */
  if (name === 'import') {
    return (
      <g>
        <path d="M8 2.4v7.2" />
        <path d="M5.2 6.8 8 9.6l2.8-2.8" />
        <path d="M2.8 12.4h10.4" />
      </g>
    )
  }
  /** 导出：向上的箭头离开托盘（写出到外部） */
  if (name === 'export') {
    return (
      <g>
        <path d="M8 11.6V3.6" />
        <path d="M5.2 6.4 8 3.6l2.8 2.8" />
        <path d="M2.8 12.4h10.4" />
      </g>
    )
  }
  /** 搜索：放大镜 */
  if (name === 'search') {
    return (
      <g>
        <circle cx="7" cy="7" r="4.6" />
        <path d="M10.4 10.4 13.6 13.6" />
      </g>
    )
  }
  /** 警告：三角形 + 感叹号 */
  if (name === 'warning') {
    return (
      <g>
        <path d="M8 2.6 14 12.8H2z" />
        <path d="M8 6.4v3M8 11.2v.01" />
      </g>
    )
  }
  /** 信息：圆 + i（用描边圆而非实心，与 warning 并列时不致突兀） */
  if (name === 'info') {
    return (
      <g>
        <circle cx="8" cy="8" r="5.8" />
        <path d="M8 7.2v4M8 4.9v.01" />
      </g>
    )
  }
  /** 设置：齿轮。
      用"外圈 + 齿"的轮廓而不是"中心圆 + 八条射线" ——
      后者在 13–14px 下射线太细，会跟「亮色」图标的太阳混为一谈。
      这里外轮廓带明显齿形，小尺寸下也能一眼认出是齿轮。 */
  if (name === 'settings') {
    return (
      <g>
        <path d="M8 1.9a1.3 1.3 0 0 1 1.24.9l.18.55c.13.4.48.68.9.73l.57.07a1.3 1.3 0 0 1 1.05 1.9l-.28.5a1.13 1.13 0 0 0 0 1.1l.28.5a1.3 1.3 0 0 1-1.05 1.9l-.57.07c-.42.05-.77.33-.9.73l-.18.55a1.3 1.3 0 0 1-2.48 0l-.18-.55a1.13 1.13 0 0 0-.9-.73l-.57-.07a1.3 1.3 0 0 1-1.05-1.9l.28-.5a1.13 1.13 0 0 0 0-1.1l-.28-.5a1.3 1.3 0 0 1 1.05-1.9l.57-.07c.42-.05.77-.33.9-.73l.18-.55A1.3 1.3 0 0 1 8 1.9z" />
        <circle cx="8" cy="8" r="2.1" />
      </g>
    )
  }
  /** 主题：半明半暗的圆 */
  if (name === 'theme') {
    return (
      <g>
        <circle cx="8" cy="8" r="5.8" />
        <path d="M8 2.2v11.6" />
        <path d="M8 2.2a5.8 5.8 0 0 1 0 11.6z" fill="currentColor" stroke="none" />
      </g>
    )
  }
  /** 恢复默认：逆时针回退箭头 + 虚线圈。
      原先用的是 refresh 的镜像（同一条弧、换个方向），
      在按钮里看起来就是"刷新翻过来"，与"恢复出厂设置"的语义对不上。
      这里改用"虚线圈 + 逆时针箭头"：虚线圈表示出厂状态，箭头表示回退过去。 */
  if (name === 'reset') {
    return (
      <g>
        <path
        d="M8 2.4a5.6 5.6 0 1 1-5.2 3.6" strokeDasharray="2.2 2" />
        <path d="M2.4 2.6v3.6h3.6" />
      </g>
    )
  }
  /** 向上插入 / 向上移动 */
  if (name === 'arrow-up') {
    return (
      <g>
        <path d="M8 13V3.4" />
        <path d="M4.2 7.2 8 3.4l3.8 3.8" />
      </g>
    )
  }
  /** 向右（收起抽屉、前进） */
  if (name === 'arrow-right') {
    return (
      <g>
        <path d="M3 8h9.6" />
        <path d="M8.8 4.2 12.6 8l-3.8 3.8" />
      </g>
    )
  }
  /** 向下插入 / 向下移动 */
  if (name === 'arrow-down') {
    return (
      <g>
        <path d="M8 3v9.6" />
        <path d="M4.2 8.8 8 12.6l3.8-3.8" />
      </g>
    )
  }
  /** 连接栏收起：左侧竖线（代表面板边界）+ 指向左边的箭头。
      竖线是"这是某个面板的边缘"的通用语汇；只用箭头容易被误读成"返回"。 */
  if (name === 'sidebar-collapse') {
    return (
      <g>
        <path d="M2.6 2.8v10.4" />
        <path d="M13 8H5.6" />
        <path d="M8.4 4.8 5.2 8l3.2 3.2" />
      </g>
    )
  }
  /** 连接栏展开：同上，箭头指向右侧。
      图形墨迹只占 2.6~10.8，在 16 视图框里偏左 1.3，
      补一次平移让按钮内的视觉重心落在正中。 */
  if (name === 'sidebar-expand') {
    return (
      <g transform="translate(1.3 0)">
        <path d="M2.6 2.8v10.4" />
        <path d="M3 8h7.4" />
        <path d="M7.6 4.8 10.8 8l-3.2 3.2" />
      </g>
    )
  }
  /** 亮色：太阳（中心圆 + 八道光芒） */
  if (name === 'sun') {
    return (
      <g>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
      </g>
    )
  }
  /** 暗色：月亮（缺角圆，用两段弧拼出月牙） */
  if (name === 'moon') {
    return (
      <g>
        <path d="M13 9.4A5.6 5.6 0 0 1 6.6 3a5.8 5.8 0 1 0 6.4 6.4z" />
      </g>
    )
  }
  /** 深海皮肤：单条波浪。
      用 q/t 连续三次起伏的最简波浪线（单条路径），
      与 sun/moon/theme 同等的简洁度；在主题菜单里
      「重复的横向起伏」即足以读出"水"的意象。 */
  if (name === 'ocean') {
    return (
      <g>
        <path d="M2.4 8q1.8-2.8 3.6 0t3.6 0 3.6 0" />
      </g>
    )
  }
  /** 暖纸皮肤：日出（半圆坐在地平线上）。
      Solarized 的意象是"晨光下的暖色纸面"——
      半圆+横线两个元素的标准日出符号，
      与 sun（整圆+光芒）一眼可区分。 */
  if (name === 'solarized') {
    return (
      <g>
        <path d="M2.6 9.6h10.8" />
        <path d="M5.3 9.6a2.7 2.7 0 0 1 5.4 0" />
      </g>
    )
  }
  /** 墨林皮肤：双层云杉。
      一笔勾出「上层小三角 + 下层大三角」的树冠轮廓 + 居中树杆，
      两笔即一棵树；13px 下靠"两层收窄的三角形"读出森林的意象。 */
  if (name === 'forest') {
    return (
      <g>
        <path d="M8 2.4 4.6 7h2.2L4.2 11.2h7.6L9.2 7h2.2L8 2.4z" />
        <path d="M8 11.2v2.4" />
      </g>
    )
  }
  /** 樱花皮肤：五点花（中心圆 + 四瓣）。
      四个 stroke 圆瓣围绕中心小圆 —— 与 sun（中心圆+直线光芒）
      的区别在"圆瓣 vs 射线"，小尺寸下也是清晰的花形。 */
  if (name === 'sakura') {
    return (
      <g>
        <circle cx="8" cy="8" r="1.4" />
        <circle cx="8" cy="3.6" r="2" />
        <circle cx="12.4" cy="8" r="2" />
        <circle cx="8" cy="12.4" r="2" />
        <circle cx="3.6" cy="8" r="2" />
      </g>
    )
  }
  /** 薄荷皮肤：一片叶子（两段弧拼出叶形 + 对角主脉）。
      与主题菜单里的太阳/月亮/波浪等天象符号形成"植物"这一独立语汇。 */
  if (name === 'mint') {
    return (
      <g>
        <path d="M4.4 11.6C4.4 7 7.8 3.6 12.4 3.6 12.4 8.2 9 11.6 4.4 11.6z" />
        <path d="M4.4 11.6 12.4 3.6" />
      </g>
    )
  }
  /** 雾蓝皮肤：云 + 底部雾线。
      平底线 + 左大右小的两段圆弧拼出云的轮廓，下方一条短横线是雾带
      ——「云压着雾」正是雾天的标准天气符号。 */
  if (name === 'mist') {
    return (
      <g>
        <path d="M11.7 11.7H6a4.7 4.7 0 1 1 4.5-6h1.2a3 3 0 1 1 0 6z" />
        <path d="M3.6 14.6h8.8" />
      </g>
    )
  }
  /** 极光皮肤：两道弧形光带 + 右上角一颗星。
      上带弧度更大、下带更平，形成「幕帘向外扩散」的层次；
      星点是极光夜空里唯一的实心元素，尺寸压到 r=0.9 避免抢焦点。 */
  if (name === 'aurora') {
    return (
      <g>
        <path d="M2.6 9.6c2.2-3.3 4.4-5 6.6-5s4.3 1.7 6.2 5" />
        <path d="M3.7 12.9c1.8-2.5 3.6-3.8 5.4-3.8s3.5 1.3 5.1 3.8" />
        <circle cx="12.7" cy="3.5" r=".9" />
      </g>
    )
  }
  /** 汉堡菜单：三条等长横线。
      与 `menu`（三个竖点）区分得很清楚：竖点表示"这一项还有更多操作"，
      三条横线表示"打开一个面板 / 菜单"。 */
  if (name === 'hamburger') {
    return (
      <g>
        <path d="M3 4.4h10M3 8h10M3 11.6h10" />
      </g>
    )
  }
  /** 滑块调节：三条轨道 + 不同位置的旋钮（表达"可调参数"） */
  if (name === 'sliders') {
    return (
      <g>
        <path d="M2.6 4.2h3.2M8.4 4.2h5M2.6 8h6.2M11.4 8h2M2.6 11.8h1.6M6.8 11.8h6.6" />
        <circle cx="6.9" cy="4.2" r="1.4" />
        <circle cx="10" cy="8" r="1.4" />
        <circle cx="5.2" cy="11.8" r="1.4" />
      </g>
    )
  }
  /** 多标签溢出：左右箭头（单笔画 chevron，与侧栏收起箭头同语言） */
  if (name === 'chevron-left') {
    return (
      <g>
        <path d="M10 3.4 5.4 8l4.6 4.6" />
      </g>
    )
  }
  if (name === 'chevron-right') {
    return (
      <g>
        <path d="M6 3.4 10.6 8 6 12.6" />
      </g>
    )
  }
  /** 语言：地球 + 经线。纬线用两段短弧，避免小尺寸下线太多糊成墨团 */
  if (name === 'globe') {
    return (
      <g>
        <circle cx="8" cy="8" r="5.8" />
        <path d="M2.2 8h11.6" />
        <path d="M8 2.2c1.7 1.6 2.6 3.6 2.6 5.8S9.7 12.2 8 13.8C6.3 12.2 5.4 10.2 5.4 8S6.3 3.8 8 2.2z" />
      </g>
    )
  }
  /** 监控：坐标系 + 折线（小尺寸下不做数据点，避免糊成墨点） */
  if (name === 'chart') {
    return (
      <g>
        <path d="M2.6 2.6v10.2a.6.6 0 0 0 .6.6h10.2" />
        <path d="M4.8 10.6 7.2 7.8l2 1.6 3-4" />
      </g>
    )
  }
  /** 键空间通知：铃铛 + 铃舌 */
  if (name === 'bell') {
    return (
      <g>
        <path d="M3.6 11.4h8.8l-1-1.5V7.2a3.4 3.4 0 0 0-6.8 0v2.7z" />
        <path d="M6.5 13.2a1.6 1.6 0 0 0 3 0" />
      </g>
    )
  }
  /** 导入 / 导出连接：单托盘 + 双向箭头。
      语义：托盘沿用现有「导入/导出」图标的既有认知（向托盘里放 / 从托盘里取），
      两支箭头一进一出，把「这一个入口同时管导入和导出」讲清楚。
      几何取舍（13px 实测）：
      - 只留一条底托。一版画上下两条托盘的版本，13px 下 5 段笔画把负空间填满、
        与箭头糊成一团，已废弃；
      - 两支箭头左右分开（间距 4.6），不做对称重叠，避免缩略时并成一根粗柱；
      - 托盘放在 y=12.8，与箭头最低点留 2.9 的净空，缩放后不会贴上箭头尾部。
      整体 bbox 中心正好落在 (8, 8)，与相邻的 add / trash 图标同心。 */
  if (name === 'transfer') {
    return (
      <g>
        <path d="M3.4 12.8h9.2" />
        <path d="M5.7 9.9V3.2M4.2 4.7 5.7 3.2l1.5 1.5" />
        <path d="M10.3 3.2v6.7M8.8 8.4l1.5 1.5 1.5-1.5" />
      </g>
    )
  }
  /** 收藏：五角星（激活态由调用方的 fill 样式补实心） */
  if (name === 'star') {
    return (
      <path d="M8 2.1 9.8 5.8l4 .6-2.9 2.8.7 4L8 11.3l-3.6 1.9.7-4-2.9-2.8 4-.6z" />
    )
  }
  /** JWT：钥匙 */
  if (name === 'key') {
    return (
      <g>
        <circle cx="5.2" cy="8" r="2.4" />
        <path d="M7.6 8H14M11.4 8v2.2M13.2 8v1.6" />
      </g>
    )
  }
  /** 编码转换：一对反向箭头 */
  if (name === 'convert') {
    return (
      <g>
        <path d="M2.8 6h8.4l-2-2M13.2 10H4.8l2 2" />
      </g>
    )
  }
  /** 代码：尖括号 */
  if (name === 'code') {
    return (
      <g>
        <path d="M5.5 4 2.5 8l3 4M10.5 4l3 4-3 4" />
      </g>
    )
  }
  /** 压缩包：盒盖 + 拉链 */
  if (name === 'archive') {
    return (
      <g>
        <rect x="2.5" y="3" width="11" height="3" rx=".6" />
        <path d="M3.5 6v6.5h9V6M6.5 8.5h3" />
      </g>
    )
  }
  /** 二进制：四格 */
  if (name === 'binary') {
    return (
      <g>
        <rect x="2.5" y="2.5" width="4" height="4" rx=".5" />
        <rect x="9.5" y="2.5" width="4" height="4" rx=".5" />
        <rect x="2.5" y="9.5" width="4" height="4" rx=".5" />
        <rect x="9.5" y="9.5" width="4" height="4" rx=".5" />
      </g>
    )
  }
  return null
}

export function DialogIcon({ name, size, className }: DialogIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      /* s-dialog-icon 是样式作用域类（components.css 以 .s-dialog-icon.dlg-ico 双形态命中） */
      className={className ? `dlg-ico s-dialog-icon ${className}` : 'dlg-ico s-dialog-icon'}
      style={{ width: `${size ?? 13}px`, height: `${size ?? 13}px` }}
      aria-hidden="true"
    >
      {renderGlyph(name)}
    </svg>
  )
}

export default DialogIcon
