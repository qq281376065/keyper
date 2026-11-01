; ============================================================================
; Keyper — 安装器视觉主题（原生 nsDialogs 实现）
; ============================================================================
;
; NSIS 的自定义页没有圆角卡片、按钮胶囊那套控件，能用的只有 STATIC /
; BUTTON / EDIT 这些原生窗口。这里用「不透明 STATIC 拼色块 + 1u 描边 +
; 透明文字」做出接近设计稿的层次：
;
;   · RD_PANEL   —— 一个纯色块（可当卡片底、分隔线、左边条）
;   · RD_BORDER  —— 四条 1u 色带组成的描边（STATIC 没有边框样式）
;   · RD_CARD    —— 色块 + 描边
;   · RD_TEXT*   —— 覆盖在色块上的透明文字（支持省略号/居中）
;   · RD_DOT     —— 实心圆 + 居中文字（步骤圆点、完成徽标），靠 region 裁圆
;
; 颜色一律写成 RGB 十六进制：SetCtlColors 实测按 RGB 解释，不是 COLORREF。
;
; 除 RD_CIRCLE 会临时压一个句柄（调用后自动弹出）外，所有宏只使用
; $RdCtlScratch 一个句柄变量，不改 $0~$9 —— 调用方经常正拿寄存器算路径。
; ============================================================================

!ifndef RD_THEME_INCLUDED
!define RD_THEME_INCLUDED

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"

; ------------------------------------------------------------------ 画布尺寸
; 内页（控件 1018）模板是 300×140 DLU。本包在运行时把它撑到 RD_PAGE_*，
; 所有页面排版都以 RD_PAGE_W 为可用宽度 —— 改这一处，分隔线等公共宏自动跟随。
!define RD_TPL_W    300
!define RD_TPL_H    140
!define RD_PAGE_W   400
!define RD_PAGE_H   210
!define RD_PAGE_W2  384                    ; RD_PAGE_W - 16（卡片内细分隔线左右各留 8u）

; ------------------------------------------------------------------ 设计色板
!define RD_INK             0x111827
!define RD_MUTED           0x6B7280
!define RD_FAINT           0x9CA3AF
!define RD_LINE            0xE5E7EB
!define RD_LINE_SOFT       0xEEF0F3
!define RD_BORDER          0xD1D5DB
!define RD_FILL            0xF7F8FA
!define RD_FILL_SOFT       0xFAFBFC
!define RD_STEP_LINE       0xD6DBE2
!define RD_BLUE            0x0F6CBD
!define RD_BLUE_SOFT       0xEAF3FB
!define RD_GREEN           0x1A7F37
!define RD_GREEN_SOFT      0xECFDF3
!define RD_GREEN_LINE      0xBBF7D0
!define RD_RED             0xB8322A
!define RD_RED_SOFT        0xFEF2F2
!define RD_RED_LINE        0xF7C9C9
!define RD_BRAND           0xC0392B
!define RD_BRAND_SOFT      0xFDF3F2
!define RD_BRAND_LINE      0xF3C6C2
!define RD_WHITE           0xFFFFFF                  ; 深底圆点上的文字
!define RD_DOT_IDLE        0xF3F4F6                  ; 未到达步骤的圆点底色

; ------------------------------------------------------------------ 色块 / 描边
; nsDialogs 新建的子控件会落到 z-order 底部，后建的卡片会盖住先建的文字。
; 统一在创建后提到最前，让「创建顺序 = 绘制顺序」。
!macro RD_TO_FRONT HANDLE
  System::Call 'user32::SetWindowPos(p ${HANDLE}, p 0, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

!macro RD_PANEL_RAW X Y W H COLOR HANDLE
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}" "0" ${X} ${Y} ${W} ${H} ""
  Pop ${HANDLE}
  SetCtlColors ${HANDLE} 0x000000 ${COLOR}
  !insertmacro RD_TO_FRONT ${HANDLE}
!macroend

!macro RD_PANEL X Y W H COLOR HANDLE
  !insertmacro RD_PANEL_RAW ${X}u ${Y}u ${W}u ${H}u ${COLOR} ${HANDLE}
!macroend

; 四条 1u 色带。坐标是 DLU 数字，不能再带 u 后缀（IntOp 只吃纯数字）。
!macro RD_BORDER X Y W H COLOR
  Push $0
  !insertmacro RD_PANEL ${X} ${Y} ${W} 1 ${COLOR} $RdCtlScratch
  IntOp $0 ${Y} + ${H}
  IntOp $0 $0 - 1
  !insertmacro RD_PANEL_RAW ${X}u $0u ${W}u 1u ${COLOR} $RdCtlScratch
  !insertmacro RD_PANEL ${X} ${Y} 1 ${H} ${COLOR} $RdCtlScratch
  IntOp $0 ${X} + ${W}
  IntOp $0 $0 - 1
  !insertmacro RD_PANEL_RAW $0u ${Y}u 1u ${H}u ${COLOR} $RdCtlScratch
  Pop $0
!macroend

!macro RD_CARD X Y W H FILL BORDER
  !insertmacro RD_PANEL ${X} ${Y} ${W} ${H} ${FILL} $RdCtlScratch
  !insertmacro RD_BORDER ${X} ${Y} ${W} ${H} ${BORDER}
!macroend

!macro RD_RULE Y COLOR
  !insertmacro RD_PANEL 0 ${Y} ${RD_PAGE_W} 1 ${COLOR} $RdCtlScratch
!macroend

; 卡片内部的细分隔线：左右各留 8u，避免顶到描边
!macro RD_CARD_RULE Y
  !insertmacro RD_PANEL 8 ${Y} ${RD_PAGE_W2} 1 ${RD_LINE_SOFT} $RdCtlScratch
!macroend

; ------------------------------------------------------------------ 文字
; SS_NOTIFY 让文字也能当链接点击；WS_EX_TRANSPARENT 让底下卡片的颜色透出来。
!macro RD_TEXT X Y W H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${COLOR} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
!macroend

!macro RD_TEXT_ELLIPSIS X Y W H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_ENDELLIPSIS}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${COLOR} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
!macroend

!macro RD_TEXT_PATH X Y W H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_PATHELLIPSIS}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${COLOR} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
!macroend

!macro RD_TEXT_CENTER X Y W H TEXT FONT COLOR
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${COLOR} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
!macroend

!macro RD_LINK X Y W H TEXT FONT HANDLER
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${RD_BLUE} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
  ${NSD_OnClick} $RdCtlScratch ${HANDLER}
!macroend

!macro RD_LINK_RIGHT X Y W H TEXT FONT HANDLER
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_RIGHT}" "${WS_EX_TRANSPARENT}" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  SetCtlColors $RdCtlScratch ${RD_BLUE} transparent
  !insertmacro RD_TO_FRONT $RdCtlScratch
  ${NSD_OnClick} $RdCtlScratch ${HANDLER}
!macroend

; 原生按钮：悬停/按下/焦点框都交给 comctl32，比自己给 STATIC 拼假悬停态可靠，
; 也让"能点"这件事有公认的视觉信号（动作型控件用它，纯文字入口才用 RD_LINK）。
!macro RD_BUTTON X Y W H TEXT FONT HANDLER
  nsDialogs::CreateControl BUTTON "${DEFAULT_STYLES}|${WS_TABSTOP}" "0" ${X}u ${Y}u ${W}u ${H}u "${TEXT}"
  Pop $RdCtlScratch
  SendMessage $RdCtlScratch ${WM_SETFONT} ${FONT} 1
  !insertmacro RD_TO_FRONT $RdCtlScratch
  ${NSD_OnClick} $RdCtlScratch ${HANDLER}
!macroend

; ------------------------------------------------------------------ 圆形色块
; STATIC 没有圆角样式，GDI 位图又没有 alpha 通道（预渲染 BMP 只能靠铺底色
; 冒充透明），所以改用窗口 region：控件本体是纯色底 STATIC，文字直接写在
; 中间，region 只负责把方角切成圆。region 坐标是控件相对像素，先量控件实际
; 像素尺寸，高 DPI 下自动跟随，不需要按 DLU 反算。
!macro RD_SHAPE_CODE PREFIX

Function ${PREFIX}RdShapeCircle         ; 栈顶入参：控件句柄
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  System::Alloc 16
  Pop $1
  System::Call 'user32::GetWindowRect(p $0, p $1)i.r2'
  System::Call '*$1(i.r2,i.r3,i.r4,i.r5)i.r6'
  System::Free $1
  IntOp $4 $4 - $2                      ; 宽 px
  IntOp $5 $5 - $3                      ; 高 px
  System::Call 'gdi32::CreateEllipticRgn(i 0,i 0,i $4,i $5)p.r1'
  System::Call 'user32::SetWindowRgn(p $0, p $1, i 1)i.r2'
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
  !insertmacro RD_SHAPE_CODE ""
!else
  !insertmacro RD_SHAPE_CODE "un."
!endif

; 把控件裁成圆/椭圆（句柄会被压栈再取出，调用后句柄变量不变）
!macro RD_CIRCLE HANDLE
  Push ${HANDLE}
  !ifdef BUILD_UNINSTALLER
    Call un.RdShapeCircle
  !else
    Call RdShapeCircle
  !endif
!macroend

; 圆形徽标：直径 ${D}u 的实心圆 + 居中文字（步骤圆点、完成徽标共用）
!macro RD_DOT X Y D FILL TEXT TEXTCOLOR FONT HANDLE
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE}" "0" ${X}u ${Y}u ${D}u ${D}u "${TEXT}"
  Pop ${HANDLE}
  SendMessage ${HANDLE} ${WM_SETFONT} ${FONT} 1
  SetCtlColors ${HANDLE} ${TEXTCOLOR} ${FILL}
  !insertmacro RD_CIRCLE ${HANDLE}
  !insertmacro RD_TO_FRONT ${HANDLE}
!macroend

!endif
