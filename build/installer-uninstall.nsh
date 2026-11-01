; ============================================================================
; Keyper — 卸载「选项」页与「完成」页
; ============================================================================
;
; 目标形态（三段向导）：
;   卸载选项 → 正在卸载（MUI_UNPAGE_INSTFILES）→ 完成
;
; 模板的卸载流程是「欢迎页 → 安装模式 → 进度 → (MUI 完成页)」：
;   · customUnWelcomePage 用来**替代**默认欢迎页，这里换成卸载选项页；
;   · 安装模式页在只存在当前用户安装时会被模板自动跳过
;     （multiUserUi.nsh 的 uninstaller 分支），不需要强制；
;   · 模板末尾的 MUI_UNPAGE_FINISH 无法用 !undef 覆盖（宏不是 define），
;     改为在 customUninstallPage 里挂 PRE 回调 Abort 跳页，
;     再插入我们自己的完成页。
;
; 配置保留/删除的选择结果通过 $RdDelConfig 传给 customRemoveFiles
; （见 installer-config.nsh）：1 = 删除，0 = 保留（默认）。
;
; 视觉与安装页共用 installer-theme.nsh：白色选项卡 + 绿色「推荐」徽标,
; 完成页徽标 / 摘要卡片 / 彩色说明条。
; ============================================================================

!ifdef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"

Var RdConfigKeepPath      ; <安装目录父>\Keyper-config（用于界面展示）
Var RdUnStep              ; 0=卸载选项，2=完成
Var RdUnChoice            ; 0=保留（默认），1=删除；返回本页时恢复选择
Var RdUnHeaderTitle
Var RdUnHeaderSub
Var RdUnFontSection
Var RdUnFontSmall
Var RdUnFontTiny
Var RdUnFontChip
Var RdUnFontStep
Var RdUnFontStepIdle
Var RdUnFontHeading
Var RdUnFontDot
Var RdUnFontBadge
Var RdUnCtlKeep
Var RdUnCtlDelete

; ---------------------------------------------------------------------------
; 静默卸载（/S，含升级时旧卸载器被静默调用）：一律保留配置
; ---------------------------------------------------------------------------
!macro customUnInit
  StrCpy $RdConfigKeep ""
  StrCpy $RdDelConfig 0
  StrCpy $RdConfigExisted 0
  StrCpy $RdConfigKeepPath ""
  StrCpy $RdUnChoice 0
!macroend

; ---------------------------------------------------------------------------
; 页面插入点
;
; customUnWelcomePage 在模板里位于 MUI_UNPAGE_INSTFILES 之前：
; 这里除了声明选项页，还顺手给紧随其后的进度页设定标题。
; ---------------------------------------------------------------------------
!macro customUnWelcomePage
  UninstPage custom un.RdUnOptionsCreate un.RdUnOptionsLeave

  ; 卸载进度页按模板尺寸（450px 画布）显示，副标题必须短到一行放得下，
  ; 否则会被挤成两行压到进度条上。步骤序号由页内文案自解释。
  !define MUI_PAGE_HEADER_TEXT "正在卸载 Keyper"
  !define MUI_PAGE_HEADER_SUBTEXT "正在移除程序文件，请勿关闭此窗口。"
  ; 保险丝：若 SHOW 钩子真的能落到进度页（PAGE_INSTALL_MODE 会 !undef 掉它，
  ; 实测拿不到），进度页会退回放大态；拿不到就保持选项页 LEAVE 收缩后的原生态。
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.RdGrowBuiltinPage
!macroend

!macro customUninstallPage
  UninstPage custom un.RdUnFinishCreate un.RdUnFinishLeave

  ; 跳过模板自带的 MUI_UNPAGE_FINISH（它紧跟在 customUninstallPage 之后）
  !define MUI_PAGE_CUSTOMFUNCTION_PRE un.RdSkipMuiFinish
!macroend

Function un.RdSkipMuiFinish
  Abort
FunctionEnd

; ============================================================================
; 公共绘制
; ============================================================================

Function un.RdApplyHeader
  Push $0
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$RdUnHeaderTitle"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$RdUnHeaderSub"
  ${EndIf}
  Pop $0
FunctionEnd

Function un.RdMakeFonts
  CreateFont $RdUnFontSection "$(^Font)" "10" "700"
  CreateFont $RdUnFontSmall "$(^Font)" "9" "400"
  CreateFont $RdUnFontTiny "$(^Font)" "8" "400"
  CreateFont $RdUnFontChip "$(^Font)" "8" "400"
  CreateFont $RdUnFontStep "$(^Font)" "10" "700"
  CreateFont $RdUnFontStepIdle "$(^Font)" "10" "400"
  CreateFont $RdUnFontHeading "$(^Font)" "18" "700"
  CreateFont $RdUnFontDot "$(^Font)" "8" "700"
  CreateFont $RdUnFontBadge "$(^Font)" "20" "700"
FunctionEnd

; 步骤条三段均分 400u 画布，坐标与安装侧 RdDrawStepper 一致
Function un.RdDrawStepper
  ${If} $RdUnStep == 2
    !insertmacro RD_PANEL 68 6 54 1 ${RD_GREEN_LINE} $RdCtlScratch
    !insertmacro RD_PANEL 198 6 54 1 ${RD_GREEN_LINE} $RdCtlScratch
    !insertmacro RD_DOT 0 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdUnFontDot $RdCtlScratch
    !insertmacro RD_DOT 130 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdUnFontDot $RdCtlScratch
    !insertmacro RD_DOT 260 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdUnFontDot $RdCtlScratch

    !insertmacro RD_TEXT 16 1 48 11 "卸载选项" $RdUnFontStep ${RD_GREEN}
    !insertmacro RD_TEXT 146 1 48 11 "正在卸载" $RdUnFontStep ${RD_GREEN}
    !insertmacro RD_TEXT 276 1 36 11 "完成" $RdUnFontStep ${RD_GREEN}

    !insertmacro RD_CARD 334 0 64 13 ${RD_GREEN_SOFT} ${RD_GREEN_LINE}
    !insertmacro RD_TEXT_CENTER 334 3 64 8 "第 3 / 3 步" $RdUnFontChip ${RD_GREEN}
  ${Else}
    !insertmacro RD_PANEL 68 6 54 1 ${RD_STEP_LINE} $RdCtlScratch
    !insertmacro RD_PANEL 198 6 54 1 ${RD_STEP_LINE} $RdCtlScratch
    !insertmacro RD_DOT 0 0 13 ${RD_BLUE} "1" ${RD_WHITE} $RdUnFontDot $RdCtlScratch
    !insertmacro RD_DOT 130 0 13 ${RD_DOT_IDLE} "2" ${RD_MUTED} $RdUnFontDot $RdCtlScratch
    !insertmacro RD_DOT 260 0 13 ${RD_DOT_IDLE} "3" ${RD_MUTED} $RdUnFontDot $RdCtlScratch

    !insertmacro RD_TEXT 16 1 48 11 "卸载选项" $RdUnFontStep ${RD_BLUE}
    !insertmacro RD_TEXT 146 1 48 11 "正在卸载" $RdUnFontStepIdle ${RD_MUTED}
    !insertmacro RD_TEXT 276 1 36 11 "完成" $RdUnFontStepIdle ${RD_MUTED}

    !insertmacro RD_CARD 334 0 64 13 0xF3F4F6 ${RD_LINE}
    !insertmacro RD_TEXT_CENTER 334 3 64 8 "第 1 / 3 步" $RdUnFontChip ${RD_MUTED}
  ${EndIf}
FunctionEnd

; $INSTDIR 的父目录 + Keyper-config（展示用；customRemoveFiles 用 $INSTDIR\..\ 相对写法）
Function un.RdComputeConfigKeep
  Push $0
  Push $1
  StrCpy $RdConfigKeepPath "$INSTDIR\..\Keyper-config"
  StrLen $1 $INSTDIR
  IntOp $1 $1 - 1
  un_cck_loop:
    ${If} $1 < 0
      Goto un_cck_done
    ${EndIf}
    StrCpy $0 $INSTDIR 1 $1
    ${If} $0 == "\"
      StrCpy $0 $INSTDIR $1
      StrCpy $RdConfigKeepPath "$0\Keyper-config"
      Goto un_cck_done
    ${EndIf}
    IntOp $1 $1 - 1
    Goto un_cck_loop
  un_cck_done:
  Pop $1
  Pop $0
FunctionEnd

Function un.RdPickKeep
  Pop $0
  ${NSD_SetState} $RdUnCtlKeep ${BST_CHECKED}
  ${NSD_SetState} $RdUnCtlDelete ${BST_UNCHECKED}
FunctionEnd

Function un.RdPickDelete
  Pop $0
  ${NSD_SetState} $RdUnCtlKeep ${BST_UNCHECKED}
  ${NSD_SetState} $RdUnCtlDelete ${BST_CHECKED}
FunctionEnd

; ============================================================================
; 卸载选项页
; ============================================================================

Function un.RdUnOptionsCreate
  Call un.RdComputeConfigKeep

  Call un.RdGrowDialog

  nsDialogs::Create 1018
  Pop $RdDlg
  ${If} $RdDlg == error
    Abort
  ${EndIf}
  Call un.RdStretchDlg

  Call un.RdMakeFonts
  StrCpy $RdUnStep 0
  Call un.RdDrawStepper

  StrCpy $RdUnHeaderTitle "卸载 Keyper"
  StrCpy $RdUnHeaderSub "选择配置数据的处理方式。"
  Call un.RdApplyHeader

  !insertmacro RD_RULE 14 ${RD_LINE}

  !insertmacro RD_TEXT 0 16 200 10 "程序位置" $RdUnFontSection ${RD_INK}
  !insertmacro RD_CARD 0 32 ${RD_PAGE_W} 18 ${RD_FILL} ${RD_BORDER}
  !insertmacro RD_TEXT_PATH 4 36 392 12 "$INSTDIR" $RdUnFontSmall ${RD_MUTED}

  !insertmacro RD_TEXT 0 58 200 10 "配置数据" $RdUnFontSection ${RD_INK}

  ; ---- 保留配置（推荐）----
  !insertmacro RD_CARD 0 74 ${RD_PAGE_W} 54 0xFFFFFF ${RD_GREEN_LINE}

  ${NSD_CreateRadioButton} 8u 86u 14u 13u ""
  Pop $RdUnCtlKeep
  SendMessage $RdUnCtlKeep ${WM_SETFONT} $RdUnFontSmall 1
  !insertmacro RD_TO_FRONT $RdUnCtlKeep

  !insertmacro RD_TEXT 26 85 300 13 "保留配置数据" $RdUnFontSection ${RD_INK}
  ${NSD_OnClick} $RdCtlScratch un.RdPickKeep

  !insertmacro RD_CARD 344 84 48 15 ${RD_GREEN_SOFT} ${RD_GREEN_LINE}
  !insertmacro RD_TEXT_CENTER 344 87 48 10 "推荐" $RdUnFontChip ${RD_GREEN}

  !insertmacro RD_TEXT 26 104 360 11 "移动到：" $RdUnFontTiny ${RD_MUTED}
  ${NSD_OnClick} $RdCtlScratch un.RdPickKeep
  !insertmacro RD_TEXT_PATH 26 116 360 11 "$RdConfigKeepPath" $RdUnFontTiny ${RD_MUTED}
  ${NSD_OnClick} $RdCtlScratch un.RdPickKeep

  ; ---- 删除配置 ----
  !insertmacro RD_CARD 0 136 ${RD_PAGE_W} 48 0xFFFFFF ${RD_LINE}

  ${NSD_CreateRadioButton} 8u 147u 14u 13u ""
  Pop $RdUnCtlDelete
  SendMessage $RdUnCtlDelete ${WM_SETFONT} $RdUnFontSmall 1
  !insertmacro RD_TO_FRONT $RdUnCtlDelete

  !insertmacro RD_TEXT 26 146 300 13 "同时删除配置数据" $RdUnFontSection ${RD_INK}
  ${NSD_OnClick} $RdCtlScratch un.RdPickDelete

  !insertmacro RD_TEXT 26 163 360 11 "连接配置、凭据、界面设置与操作日志将被永久删除。" $RdUnFontTiny ${RD_RED}
  ${NSD_OnClick} $RdCtlScratch un.RdPickDelete

  ; 恢复上次选择（从进度页返回时保持原样）
  ${If} $RdUnChoice == 1
    ${NSD_SetState} $RdUnCtlKeep ${BST_UNCHECKED}
    ${NSD_SetState} $RdUnCtlDelete ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $RdUnCtlKeep ${BST_CHECKED}
    ${NSD_SetState} $RdUnCtlDelete ${BST_UNCHECKED}
  ${EndIf}

  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:卸载"

  ; 卸载选项页是第一屏（模板的欢迎页已被替换）
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0

  nsDialogs::Show
FunctionEnd

Function un.RdUnOptionsLeave
  ${NSD_GetState} $RdUnCtlDelete $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RdDelConfig 1
    StrCpy $RdUnChoice 1
  ${Else}
    StrCpy $RdDelConfig 0
    StrCpy $RdUnChoice 0
  ${EndIf}

  ; 退到模板尺寸再进卸载段：段线程改不动窗口（消息全排队到段结束），
  ; 留着一张大画布装 450×210 的原生进度页比小窗更难看。
  ; 卸载完成页的 CREATE 会把它重新放大。见 installer-resize.nsh。
  ${IfNot} ${Silent}
    Call un.RdShrinkDialog
  ${EndIf}
FunctionEnd

; ============================================================================
; 卸载完成页
; ============================================================================

Function un.RdUnFinishCreate
  Call un.RdGrowDialog

  nsDialogs::Create 1018
  Pop $RdDlg
  ${If} $RdDlg == error
    Abort
  ${EndIf}
  Call un.RdStretchDlg

  Call un.RdMakeFonts
  StrCpy $RdUnStep 2
  Call un.RdDrawStepper

  StrCpy $RdUnHeaderTitle "Keyper 已卸载"
  StrCpy $RdUnHeaderSub "程序文件与快捷方式已移除。"
  Call un.RdApplyHeader

  !insertmacro RD_DOT 0 16 40 ${RD_GREEN} "√" ${RD_WHITE} $RdUnFontBadge $RdCtlScratch
  !insertmacro RD_TEXT 50 20 320 24 "卸载完成" $RdUnFontHeading ${RD_INK}

  ; ---- 配置数据摘要 ----
  ${If} $RdConfigExisted == 0
    StrCpy $1 "未发现"
  ${ElseIf} $RdDelConfig == 1
    StrCpy $1 "已删除"
  ${ElseIf} $RdConfigKeep != ""
    StrCpy $1 "已保留"
  ${Else}
    StrCpy $1 "未能保留"
  ${EndIf}

  !insertmacro RD_CARD 0 66 ${RD_PAGE_W} 84 ${RD_FILL_SOFT} ${RD_LINE}

  !insertmacro RD_TEXT 10 72 60 11 "程序目录" $RdUnFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 72 310 12 "已移除" $RdUnFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 86

  !insertmacro RD_TEXT 10 92 60 11 "快捷方式" $RdUnFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 92 310 12 "桌面与开始菜单已移除" $RdUnFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 106

  !insertmacro RD_TEXT 10 112 60 11 "PATH" $RdUnFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 112 310 12 "安装目录条目已清理" $RdUnFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 126

  !insertmacro RD_TEXT 10 132 60 11 "配置数据" $RdUnFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 132 310 12 "$1" $RdUnFontSmall ${RD_INK}

  ; ---- 说明条 ----
  ${If} $RdConfigExisted == 0
    !insertmacro RD_PANEL 0 158 ${RD_PAGE_W} 20 ${RD_FILL} $RdCtlScratch
    !insertmacro RD_PANEL 0 158 2 20 ${RD_LINE} $RdCtlScratch
    !insertmacro RD_TEXT 8 163 384 12 "未发现需要保留的配置数据。" $RdUnFontTiny ${RD_FAINT}
  ${ElseIf} $RdDelConfig == 1
    !insertmacro RD_PANEL 0 158 ${RD_PAGE_W} 20 ${RD_RED_SOFT} $RdCtlScratch
    !insertmacro RD_PANEL 0 158 2 20 ${RD_RED} $RdCtlScratch
    !insertmacro RD_TEXT 8 163 384 12 "配置数据已删除，无法恢复。" $RdUnFontTiny ${RD_RED}
  ${ElseIf} $RdConfigKeep != ""
    !insertmacro RD_PANEL 0 158 ${RD_PAGE_W} 20 ${RD_BLUE_SOFT} $RdCtlScratch
    !insertmacro RD_PANEL 0 158 2 20 ${RD_BLUE} $RdCtlScratch
    !insertmacro RD_TEXT_PATH 8 163 384 12 "配置已保留到 $RdConfigKeepPath" $RdUnFontTiny ${RD_BLUE}
  ${Else}
    !insertmacro RD_PANEL 0 158 ${RD_PAGE_W} 20 ${RD_RED_SOFT} $RdCtlScratch
    !insertmacro RD_PANEL 0 158 2 20 ${RD_RED} $RdCtlScratch
    !insertmacro RD_TEXT 8 163 384 12 "配置目录被占用，未能自动保留。" $RdUnFontTiny ${RD_RED}
  ${EndIf}

  ; 卸载已完成：不允许后退/取消，按钮改为「完成」
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0

  nsDialogs::Show
FunctionEnd

Function un.RdUnFinishLeave
FunctionEnd

!endif
