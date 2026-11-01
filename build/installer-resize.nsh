; ============================================================================
; Keyper — 向导窗体放大
; ============================================================================
;
; NSIS 的向导模板把内页（控件 1018）固定成 300×140 DLU，96dpi 下就是
; 450×210 px；MUI2 只取句柄配色，不会重排这些控件。想放大画布只能在
; 运行时按实测尺寸做等比放大。
;
; 三个必须遵守的时机约束（都实测过）：
;   1. 不能放在 .onGUIInit —— 那时 1018 还没按页面模板摆位，量到的宽度
;      不是模板值，且随后的进页摆位会把改动全部覆盖。
;   2. 每个页面创建时都要重放：NSIS 进页会把 1018 / 1044 / 分隔线 / 三个
;      按钮摆回模板尺寸；而头部（1034/1036/1037/1038/1039/1046）不会被
;      重摆，所以只做一次（$RdWinDone）。
;   3. nsDialogs::Create 1018 拿到的是「按当前 1018 尺寸」的子对话框，
;      内页本身要在 Create 之后再 MoveWindow 一次（RdStretchDlg）。
;
; 还有一条更狠的：所有改动必须由 UI 线程发出。卸载段（含 customRemoveFiles）
; 跑在段线程里，段线程发出的窗口消息一律排队到整段结束才被处理 —— 改尺寸、
; 改标题全都延后生效，界面在段跑的这几秒里保持进页时的样子。
; 因此模板进度页只有安装侧能放大（SHOW 回调在 UI 线程），
; 卸载侧改为「进段前缩回模板、完成页再放大」（RdShrinkDialog）。
;
; 增量按「模板 DLU → 实测像素」反推，不用 GetDialogBaseUnits（实测取不到
; 返回值），因此高 DPI 下同样成立；$RdAppliedW 让同一页重复调用无害。
;
; 安装器与卸载器是两次独立编译，un. 前缀是硬性要求，所以整体做成宏，
; 按趟生成两份函数。
; ============================================================================

!ifndef RD_RESIZE_INCLUDED
!define RD_RESIZE_INCLUDED

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; 内页尺寸（RD_PAGE_W / RD_PAGE_H / RD_TPL_W / RD_TPL_H）定义在
; installer-theme.nsh —— 页面排版与这里必须用同一组常量。

; nsDialogs 子对话框句柄（各页面创建时写入）
Var RdDlg

Var RdDx            ; 宽度增量（px）
Var RdDy            ; 高度增量（px）
Var RdTargetW       ; 放大后的内页宽（px）
Var RdTargetH       ; 放大后的内页高（px）
Var RdAppliedW      ; 上一次应用后的内页宽，用于同页幂等
Var RdWinDone       ; 窗口与头部是否已放大
Var RdOx            ; 客户区原点的屏幕 X
Var RdOy            ; 客户区原点的屏幕 Y

; 读屏幕矩形：left→$1 top→$2 right→$3 bottom→$4（$9/$R8 为临时）。
; 必须走「先 Alloc 16 再解引用」两步：内联写法 *i.r1i.r2i.r3i.r4 实测只分配
; 4 字节且不回填寄存器，GetWindowRect 会越界写坏栈，量到的尺寸全是空值。
!macro RD_RECT HWND
  System::Alloc 16
  Pop $R8
  System::Call 'user32::GetWindowRect(p ${HWND}, p $R8)i.r9'
  System::Call '*$R8(i.r1,i.r2,i.r3,i.r4)i.r9'
  System::Free $R8
!macroend

; 找到进度页真正的子对话框。$HWNDPARENT 下可能同时存在多个 #32770：
; nsDialogs 页的对话框切走之后未必立刻销毁（卸载段里实测就撑大了这么个
; 不可见的残留窗，进度页反而没动）。nsDialogs 自绘控件的 ID 也从 1000 起编，
; 「有没有 1004」区分不了。判据用「该对话框里存在 msctls_progress32 子窗」：
; 类名比较交给 FindWindowEx 自己做 —— ANSI 版里 System::Call 取 GetClassNameA
; 的字符串参数实测返回垃圾，不能自己比。
; 也不能用 IsWindowVisible 过滤：页面 SHOW 回调时进度页还没置 WS_VISIBLE。
; 句柄写入 ${OUT}，找不到写 0。占用 $5/$6，$0-$4/$7-$9 不受影响。
!macro RD_FIND_PROGRESS OUT
  StrCpy ${OUT} 0
  StrCpy $5 0
  ${Do}
    System::Call 'user32::FindWindowEx(p $HWNDPARENT, p $5, t "#32770", t "")p.r5'
    ${If} $5 = 0
      ${ExitDo}
    ${EndIf}
    System::Call 'user32::FindWindowEx(p $5, p 0, t "msctls_progress32", p 0)p.r6'
    ${If} $6 != 0
      StrCpy ${OUT} $5
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

; 按增量挪动一个控件。寄存器约定：$0=句柄 $1=x $2=y $3=w $4=h，
; 所有 System::Call 的返回值显式收进 $9，否则会覆盖 $0 的句柄。
; x/y 用父窗客户区坐标，所以 $RdOx/$RdOy 必须是本次调用刚取到的客户区原点。
!macro RD_GROW_AT PARENT ID DX DY DW DH
  GetDlgItem $0 ${PARENT} ${ID}
  ${If} $0 != 0
    !insertmacro RD_RECT $0
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2
    IntOp $1 $1 - $RdOx
    IntOp $2 $2 - $RdOy
    IntOp $1 $1 + ${DX}
    IntOp $2 $2 + ${DY}
    IntOp $3 $3 + ${DW}
    IntOp $4 $4 + ${DH}
    System::Call 'user32::MoveWindow(p $0, i $1, i $2, i $3, i $4, i 0)i.r9'
  ${EndIf}
!macroend

!macro RD_GROW ID DX DY DW DH
  !insertmacro RD_GROW_AT $HWNDPARENT ${ID} ${DX} ${DY} ${DW} ${DH}
!macroend

; 绝对摆放（父窗客户区像素）。进度页的控件用这个而不是 RD_GROW_AT：
; 页面 SHOW 可能触发多次（返回上一步再进来），增量位移会叠加。
; MoveWindow 的 x/y 本身就是父窗客户区坐标，不能再加 $RdOx/$RdOy——
; 那对屏幕原点只用于把 RD_RECT 读到的屏幕坐标换算回客户区（见 RD_GROW_AT）。
!macro RD_PLACE_AT PARENT ID X Y W H
  GetDlgItem $0 ${PARENT} ${ID}
  ${If} $0 != 0
    System::Call 'user32::MoveWindow(p $0, i ${X}, i ${Y}, i ${W}, i ${H}, i 0)i.r9'
  ${EndIf}
!macroend

!macro RD_RESIZE_CODE PREFIX

; 页面创建时放大窗口骨架与模板控件（须在 nsDialogs::Create 之前调用）
Function ${PREFIX}RdGrowDialog
  ; 窗口标题：卸载器默认取语言包里 2010 年的「解除安装」，与页内文案不符。
  ; makensis v3.04 没有 WindowName 命令（实测 Invalid command），只能运行时改
  ; 标题。每张页面显示时都会走到这里，重设是幂等的。
  !ifdef BUILD_UNINSTALLER
    System::Call 'user32::SetWindowText(p $HWNDPARENT, t "${PRODUCT_NAME} 卸载")i.r9'
  !else
    System::Call 'user32::SetWindowText(p $HWNDPARENT, t "${PRODUCT_NAME} 安装")i.r9'
  !endif

  GetDlgItem $0 $HWNDPARENT 1018
  ${If} $0 == 0
    Return
  ${EndIf}
  !insertmacro RD_RECT $0
  IntOp $5 $3 - $1          ; 当前内页宽（px）
  IntOp $6 $4 - $2          ; 当前内页高（px）

  ; MoveWindow 需要父客户区坐标，用整窗背景 1044 的屏幕位置当原点。
  ; 原点每次都重取：窗口可能被用户拖走。
  GetDlgItem $0 $HWNDPARENT 1044
  ${If} $0 == 0
    Return
  ${EndIf}
  !insertmacro RD_RECT $0
  StrCpy $RdOx $1
  StrCpy $RdOy $2

  ${If} $5 == $RdAppliedW
    Return                  ; 本页已放大过，避免叠加
  ${EndIf}

  IntOp $RdTargetW $5 * ${RD_PAGE_W}
  IntOp $RdTargetW $RdTargetW / ${RD_TPL_W}
  IntOp $RdDx $RdTargetW - $5
  IntOp $RdTargetH $6 * ${RD_PAGE_H}
  IntOp $RdTargetH $RdTargetH / ${RD_TPL_H}
  IntOp $RdDy $RdTargetH - $6
  StrCpy $RdAppliedW $RdTargetW

  ${If} $RdWinDone != 1
    StrCpy $RdWinDone 1
    !insertmacro RD_RECT $HWNDPARENT
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2
    IntOp $3 $3 + $RdDx
    IntOp $4 $4 + $RdDy
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i $3, i $4, i 0x16)i.r9'
    ; 头部只放大一次：底色与文字加宽，右上的头部图/图标位右移
    !insertmacro RD_GROW 1034 0 0 $RdDx 0
    !insertmacro RD_GROW 1037 0 0 $RdDx 0
    !insertmacro RD_GROW 1038 0 0 $RdDx 0
    !insertmacro RD_GROW 1046 $RdDx 0 0 0
    !insertmacro RD_GROW 1039 $RdDx 0 0 0
    !insertmacro RD_GROW 1036 0 0 $RdDx 0
  ${EndIf}

  ; 会被 NSIS 每次进页重摆的一组：内页占位、整窗背景、分隔线、页脚、按钮
  !insertmacro RD_GROW 1018 0 0 $RdDx $RdDy
  !insertmacro RD_GROW 1044 0 0 $RdDx $RdDy
  !insertmacro RD_GROW 1035 0 $RdDy $RdDx 0
  !insertmacro RD_GROW 1045 0 $RdDy $RdDx 0
  !insertmacro RD_GROW 1028 0 $RdDy $RdDx 0
  !insertmacro RD_GROW 1256 0 $RdDy $RdDx 0
  !insertmacro RD_GROW 1 $RdDx $RdDy 0 0
  !insertmacro RD_GROW 2 $RdDx $RdDy 0 0
  !insertmacro RD_GROW 3 $RdDx $RdDy 0 0
FunctionEnd

; 退回模板尺寸 —— 与 RdGrowDialog 严格互逆，只能从 UI 线程调用
; （目前用在卸载选项页 LEAVE：让紧随其后的模板进度页以原生小窗显示，
; 免得大窗里嵌一块 450×210 的旧画布，看着像内容没排开）。
; 增量取上一次放大时量到的 $RdDx/$RdDy，高 DPI 下同样成立。
; $RdWinDone 兼作幂等锁：安装模式页 Abort 会让本页 LEAVE 再跑一次，
; 没有这道锁，头部控件会被反复往左缩到屏幕外。
;
; 只生成卸载趟的一份：安装侧进度页拿得到 UI 线程的 SHOW 钩子，用不着缩窗，
; 安装趟里零引用的函数会吃 warning 6010（makensis 的警告被 electron-builder 当错误）。
!ifdef BUILD_UNINSTALLER
Function ${PREFIX}RdShrinkDialog
  ${If} $RdWinDone != 1
    Return
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1018
  ${If} $0 == 0
    Return
  ${EndIf}

  ; $5/$6 = 负的宽高增量。RD_GROW_AT 只占用 $0-$4/$R8/$9，$5/$6 安全。
  IntOp $5 0 - $RdDx
  IntOp $6 0 - $RdDy

  ; RD_RECT 给的是屏幕四条边，先化成宽高再减增量（和 RdGrowDialog 同一套算法）。
  !insertmacro RD_RECT $HWNDPARENT
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  IntOp $3 $3 - $RdDx
  IntOp $4 $4 - $RdDy
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i $3, i $4, i 0x16)i.r9'

  ; 头部不会被 NSIS 重摆，必须自己缩回去；缩完把 $RdWinDone 清零，
  ; 下一张页面（卸载完成页）的 RdGrowDialog 才会重新放大一次。
  !insertmacro RD_GROW 1034 0 0 $5 0
  !insertmacro RD_GROW 1037 0 0 $5 0
  !insertmacro RD_GROW 1038 0 0 $5 0
  !insertmacro RD_GROW 1046 $5 0 0 0
  !insertmacro RD_GROW 1039 $5 0 0 0
  !insertmacro RD_GROW 1036 0 0 $5 0

  ; 每次进页都会被 NSIS 重摆的一组：即使它先复位成模板值，再被这里减一次
  ; 也只可能出现在「已经缩过」的重复调用上，而那由 $RdWinDone 挡住。
  !insertmacro RD_GROW 1018 0 0 $5 $6
  !insertmacro RD_GROW 1044 0 0 $5 $6
  !insertmacro RD_GROW 1035 0 $6 $5 0
  !insertmacro RD_GROW 1045 0 $6 $5 0
  !insertmacro RD_GROW 1028 0 $6 $5 0
  !insertmacro RD_GROW 1256 0 $6 $5 0
  !insertmacro RD_GROW 1 $5 $6 0 0
  !insertmacro RD_GROW 2 $5 $6 0 0
  !insertmacro RD_GROW 3 $5 $6 0 0

  StrCpy $RdWinDone 0
  StrCpy $RdAppliedW 0
FunctionEnd
!endif

; nsDialogs::Create 之后把子对话框撑到目标尺寸（$RdDlg 为页面句柄）。
; 用 SWP_NOMOVE 只改尺寸：不依赖客户区原点，窗口被拖到哪儿都对；
; 必须在创建页内控件之前调用 —— 控件坐标是 DLU，按当前对话框换算成 px。
Function ${PREFIX}RdStretchDlg
  ${If} $RdDlg == 0
  ${OrIf} $RdDlg == error
    Return
  ${EndIf}
  System::Call 'user32::SetWindowPos(p $RdDlg, p 0, i 0, i 0, i $RdTargetW, i $RdTargetH, i 0x06)i.r9'
FunctionEnd

; 模板自带的进度页（instfiles / uninstfiles）不是 nsDialogs 页：控件放在
; $HWNDPARENT 下的一个 #32770 子对话框里，内页撑大后它们仍停在模板尺寸。
; 控件 ID 见 Contrib\Modern UI 2\Pages\InstallFiles.nsh：
;   1006 = 进度文字，1004 = 进度条，1016 = 日志框，1027 = 「显示详情」按钮
; 调用时机（只限安装侧）：进度页 SHOW 回调，自定义页槽位
;   customPageAfterChangeDir 里定义的 RdInstFilesShow。SHOW 跑在 UI 线程，
;   改完立刻可见。
; 卸载侧不能调用本函数：卸载段跑在「段线程」，段里发出的窗口消息全部排队到
;   整段结束才被处理（实测宏 0.56s 结束、界面 4.4s 才变）；而模板的
;   「为谁安装/卸载」页（multiUserUi.nsh 的 PAGE_INSTALL_MODE，展开在
;   MUI_UNPAGE_INSTFILES 之前）先吞掉了 MUI_PAGE_CUSTOMFUNCTION_SHOW，
;   进度页拿不到 UI 线程的 SHOW 钩子。
;   ⇒ 卸载进度页在选项页 LEAVE 里退回模板尺寸（RdShrinkDialog），完成页
;     再放大回来。若哪天 SHOW 钩子可用，LEAVE 里的收缩会被它覆盖成放大态，
;     两种结果都不难看。
; 摆放全是绝对坐标，重复调用无害。
Function ${PREFIX}RdGrowBuiltinPage
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9

  ${If} ${Silent}
    Goto rd_builtin_done          ; 静默模式没有页面，不用等也等不到
  ${EndIf}

  Call ${PREFIX}RdGrowDialog

  StrCpy $8 0
  ${Do}
    !insertmacro RD_FIND_PROGRESS $7
    ${If} $7 != 0
    ${OrIf} $8 >= 10              ; 最多等半秒，还没建出来就放弃
      ${ExitDo}
    ${EndIf}
    IntOp $8 $8 + 1
    Sleep 50
  ${Loop}

  ${If} $7 != 0
    System::Call 'user32::SetWindowPos(p $7, p 0, i 0, i 0, i $RdTargetW, i $RdTargetH, i 0x06)i.r9'
    ; 子对话框的屏幕位置即其客户区原点（无标题栏/边框）
    !insertmacro RD_RECT $7
    StrCpy $RdOx $1
    StrCpy $RdOy $2

    ; 模板把状态文字与进度条贴在画布顶部（内页只有 210 高），放大到 315 后
    ; 上方留白会显得内容挤成一团：整组按目标画布垂直居中重摆。
    ; 日志框与「显示详情」按钮默认隐藏，但也要跟着撑开，
    ; 否则用户开启详情后会看到半截列表。
    !insertmacro RD_PLACE_AT $7 1006 0 132 $RdTargetW 16
    !insertmacro RD_PLACE_AT $7 1004 0 154 $RdTargetW 18
    IntOp $5 $RdTargetW - 92
    !insertmacro RD_PLACE_AT $7 1027 $5 124 92 21
    IntOp $5 $RdTargetH - 178
    !insertmacro RD_PLACE_AT $7 1016 0 178 $RdTargetW $5
  ${EndIf}

rd_builtin_done:
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro RD_RESIZE_CODE ""
!else
  !insertmacro RD_RESIZE_CODE "un."
!endif

!endif
