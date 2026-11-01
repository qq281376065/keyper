; ============================================================================
; Keyper — 安装「完成」页（三段向导的第 3 步）
; ============================================================================
;
; 用自定义完成页替代 MUI_PAGE_FINISH，原因有两个：
;   1. 需要在页内展示本次安装的结果摘要（版本/目录/快捷方式/PATH/配置）；
;   2. 三段向导的步骤条要延续到最后一屏。
;
; 安装进度页（MUI_PAGE_INSTFILES）由 electron-builder 模板插入，
; 本宏在其后展开（见 assistedInstaller.nsh 的 customFinishPage）。
;
; 视觉：绿色完成徽标 + 18pt 标题 + 带描边和行分隔线的摘要卡片。
; 画布与准备页一致（RD_PAGE_W × RD_PAGE_H，见 installer-theme.nsh）。
; ============================================================================

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"

Var RdCtlRun

!macro customFinishPage
  Page custom RdFinishCreate RdFinishLeave
!macroend

Function RdFinishCreate
  Call RdGrowDialog

  nsDialogs::Create 1018
  Pop $RdDlg
  ${If} $RdDlg == error
    Abort
  ${EndIf}
  Call RdStretchDlg

  Call RdMakeFonts
  StrCpy $RdStep 2
  Call RdDrawStepper

  ${If} $RdInstalled == 1
    ${If} $RdOldVersion == "${VERSION}"
      StrCpy $RdHeaderTitle "Keyper 已重新安装"
      StrCpy $RdHeaderSub "同版本程序文件已覆盖，配置保持不变。"
    ${Else}
      StrCpy $RdHeaderTitle "Keyper 已升级"
      StrCpy $RdHeaderSub "新版本已经就位，配置保持不变。"
    ${EndIf}
  ${Else}
    StrCpy $RdHeaderTitle "Keyper 已安装"
    StrCpy $RdHeaderSub "安装完成，可以开始连接 Redis 或 Memcached。"
  ${EndIf}
  Call RdApplyHeader

  ; ---- 完成徽标 + 标题 ----
  !insertmacro RD_DOT 0 16 40 ${RD_GREEN} "√" ${RD_WHITE} $RdFontBadge $RdCtlScratch

  ${If} $RdInstalled == 1
    ${If} $RdOldVersion == "${VERSION}"
      !insertmacro RD_TEXT 50 20 320 24 "重新安装完成" $RdFontHeading ${RD_INK}
    ${Else}
      !insertmacro RD_TEXT 50 20 320 24 "升级完成" $RdFontHeading ${RD_INK}
    ${EndIf}
  ${Else}
    !insertmacro RD_TEXT 50 20 320 24 "安装完成" $RdFontHeading ${RD_INK}
  ${EndIf}

  ; ---- 摘要数据 ----
  StrCpy $1 ""
  ${If} $RdOptDesktop == ${BST_CHECKED}
    StrCpy $1 "桌面"
  ${EndIf}
  ${If} $RdOptStartMenu == ${BST_CHECKED}
    ${If} $1 == ""
      StrCpy $1 "开始菜单"
    ${Else}
      StrCpy $1 "$1、开始菜单"
    ${EndIf}
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "未创建"
  ${EndIf}

  ${If} $RdInstalled == 1
    StrCpy $2 "保持现状"
  ${ElseIf} $RdOptPath == ${BST_CHECKED}
    StrCpy $2 "已加入用户 PATH"
  ${Else}
    StrCpy $2 "未修改"
  ${EndIf}

  ${If} $RdInstalled == 1
    StrCpy $3 "已保留原有配置"
  ${Else}
    StrCpy $3 "保存在安装目录的 config 子目录"
  ${EndIf}

  ; ---- 摘要卡片 ----
  ; 徽标占 16..56，摘要卡片从 66 开始，行距 18u
  !insertmacro RD_CARD 0 66 ${RD_PAGE_W} 94 ${RD_FILL_SOFT} ${RD_LINE}

  !insertmacro RD_TEXT 10 72 60 11 "版本" $RdFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 72 310 12 "${VERSION}" $RdFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 86

  !insertmacro RD_TEXT 10 90 60 11 "安装位置" $RdFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT_PATH 80 90 310 12 "$INSTDIR" $RdFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 104

  !insertmacro RD_TEXT 10 108 60 11 "快捷方式" $RdFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 108 310 12 "$1" $RdFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 122

  !insertmacro RD_TEXT 10 126 60 11 "PATH" $RdFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 126 310 12 "$2" $RdFontSmall ${RD_INK}
  !insertmacro RD_CARD_RULE 140

  !insertmacro RD_TEXT 10 144 60 11 "配置" $RdFontTiny ${RD_MUTED}
  !insertmacro RD_TEXT 80 144 310 12 "$3" $RdFontSmall ${RD_INK}

  ; ---- 立即运行 ----
  ${NSD_CreateCheckbox} 0 168u ${RD_PAGE_W}u 13u "立即运行 Keyper"
  Pop $RdCtlRun
  SendMessage $RdCtlRun ${WM_SETFONT} $RdFontSmall 1
  !insertmacro RD_TO_FRONT $RdCtlRun
  ${NSD_SetState} $RdCtlRun $RdOptLaunch

  ; 安装已完成：不允许后退/取消，按钮改为「完成」
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:完成"
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0

  nsDialogs::Show
FunctionEnd

Function RdFinishLeave
  ${NSD_GetState} $RdCtlRun $0
  ${If} $0 == ${BST_CHECKED}
    ; 用 $INSTDIR 拼路径而不是 $appExe：本函数在 common.nsh 之前编译，
    ; 引用不到 $appExe；${PRODUCT_FILENAME} 由 -D 注入，任何位置都可用。
    ${If} $RdInstalled == 1
      ExecShell "open" "$INSTDIR\${PRODUCT_FILENAME}.exe" "--updated"
    ${Else}
      ExecShell "open" "$INSTDIR\${PRODUCT_FILENAME}.exe"
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif
