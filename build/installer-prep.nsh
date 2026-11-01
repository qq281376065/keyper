; ============================================================================
; Keyper — 安装「准备」页（三段向导的第 1 步）
; ============================================================================
;
; 本页合并了旧版的三块界面：环境检查页、目录页、快捷方式勾选页。
; 页面顺序由 installer.nsh 的 customPageAfterChangeDir 决定：
; 此时 $INSTDIR 已由本页自己确定，随后的 MUI_PAGE_INSTFILES 直接安装。
;
; 两种形态共用一套回调：
;   · 全新安装 —— 2×2 环境卡片 + 可编辑安装位置 + 快捷方式/PATH 勾选
;   · 升级安装 —— 版本变化横幅 + 一行环境摘要 + 锁定原目录 + 同样的勾选
;
; 视觉层见 installer-theme.nsh：色块拼卡片、1u 色带做描边、region 裁圆做步骤圆点。
; 坐标单位是 DLU，画布 300×140 由 installer-resize.nsh
; 在运行时撑到 RD_PAGE_W×RD_PAGE_H（400×210），所以这里的排版一律以
; ${RD_PAGE_W} 为可用宽度、${RD_PAGE_H} 为下边界。
;
; 所有控件句柄都用自定义 Var 保存，不占 $0~$9 —— 页面回调里还会调用
; 检测函数，它们会改写寄存器。
; ============================================================================

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "nsDialogs.nsh"

; ------------------------------------------------------------------ 页面状态
; $RdDlg（nsDialogs 子对话框句柄）声明在 installer-resize.nsh
Var RdStep               ; 0=准备（当前），2=完成（全绿）
Var RdHeaderTitle
Var RdHeaderSub
Var RdFontSection        ; 10pt 粗
Var RdFontBold           ; 9pt 粗
Var RdFontSmall          ; 9pt
Var RdFontTiny           ; 8pt
Var RdFontChip           ; 8pt
Var RdFontStep           ; 10pt 粗
Var RdFontStepIdle       ; 10pt
Var RdFontDot            ; 8pt 粗（圆点里的序号/勾）
Var RdFontBadge          ; 20pt 粗（完成徽标里的勾）
Var RdFontHeading        ; 18pt 粗（完成页标题）

; 选项状态：默认值在 customInit 里设置，静默安装靠它兜底
Var RdOptDesktop
Var RdOptStartMenu
Var RdOptLaunch
Var RdOptPath

; ------------------------------------------------------------------ 控件句柄
Var RdCtlDesktop
Var RdCtlStartMenu
Var RdCtlLaunch
Var RdCtlPathOpt
Var RdCtlPath
Var RdCtlForce
Var RdCtlEnvLineDot
Var RdCtlEnvLineText
Var RdCtlOsDot
Var RdCtlOsVal
Var RdCtlArchDot
Var RdCtlArchVal
Var RdCtlSpaceDot
Var RdCtlSpaceVal
Var RdCtlDirDot
Var RdCtlDirVal

; ============================================================================
; 头部标题 / 步骤条 / 字体
; ============================================================================

; 运行时改写 MUI 头部（1037=标题，1038=副标题）。
; 不用 MUI_PAGE_HEADER_TEXT 是因为它的文案在编译期固定，
; 而本页需要按「全新 / 升级」切换标题。
Function RdApplyHeader
  Push $0
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$RdHeaderTitle"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$RdHeaderSub"
  ${EndIf}
  Pop $0
FunctionEnd

Function RdMakeFonts
  CreateFont $RdFontSection "$(^Font)" "10" "700"
  CreateFont $RdFontBold "$(^Font)" "9" "700"
  CreateFont $RdFontSmall "$(^Font)" "9" "400"
  CreateFont $RdFontTiny "$(^Font)" "8" "400"
  CreateFont $RdFontChip "$(^Font)" "8" "400"
  CreateFont $RdFontStep "$(^Font)" "10" "700"
  CreateFont $RdFontStepIdle "$(^Font)" "10" "400"
  CreateFont $RdFontDot "$(^Font)" "8" "700"
  CreateFont $RdFontBadge "$(^Font)" "20" "700"
  CreateFont $RdFontHeading "$(^Font)" "18" "700"
FunctionEnd

; 步骤条：圆点用 RD_DOT（纯色 STATIC + 窗口 region 裁圆，序号直接写文字），
; 连接线用 1u 色块。第 1 步高亮蓝、后续灰；完成页全部换绿勾。
; 三段均分 400u 画布：圆点 0 / 130 / 260，连接线只在文字右侧留一段。
Function RdDrawStepper
  ${If} $RdStep == 2
    !insertmacro RD_PANEL 68 6 54 1 ${RD_GREEN_LINE} $RdCtlScratch
    !insertmacro RD_PANEL 198 6 54 1 ${RD_GREEN_LINE} $RdCtlScratch
    !insertmacro RD_DOT 0 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdFontDot $RdCtlScratch
    !insertmacro RD_DOT 130 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdFontDot $RdCtlScratch
    !insertmacro RD_DOT 260 0 13 ${RD_GREEN} "√" ${RD_WHITE} $RdFontDot $RdCtlScratch
  ${Else}
    !insertmacro RD_PANEL 68 6 54 1 ${RD_STEP_LINE} $RdCtlScratch
    !insertmacro RD_PANEL 198 6 54 1 ${RD_STEP_LINE} $RdCtlScratch
    !insertmacro RD_DOT 0 0 13 ${RD_BLUE} "1" ${RD_WHITE} $RdFontDot $RdCtlScratch
    !insertmacro RD_DOT 130 0 13 ${RD_DOT_IDLE} "2" ${RD_MUTED} $RdFontDot $RdCtlScratch
    !insertmacro RD_DOT 260 0 13 ${RD_DOT_IDLE} "3" ${RD_MUTED} $RdFontDot $RdCtlScratch
  ${EndIf}

  ${If} $RdStep == 2
    !insertmacro RD_TEXT 16 1 48 11 "准备" $RdFontStep ${RD_GREEN}
    !insertmacro RD_TEXT 146 1 48 11 "正在安装" $RdFontStep ${RD_GREEN}
    !insertmacro RD_TEXT 276 1 36 11 "完成" $RdFontStep ${RD_GREEN}
    !insertmacro RD_CARD 334 0 64 13 ${RD_GREEN_SOFT} ${RD_GREEN_LINE}
    !insertmacro RD_TEXT_CENTER 334 3 64 8 "第 3 / 3 步" $RdFontChip ${RD_GREEN}
  ${Else}
    !insertmacro RD_TEXT 16 1 48 11 "准备" $RdFontStep ${RD_BLUE}
    !insertmacro RD_TEXT 146 1 48 11 "正在安装" $RdFontStepIdle ${RD_MUTED}
    !insertmacro RD_TEXT 276 1 36 11 "完成" $RdFontStepIdle ${RD_MUTED}
    !insertmacro RD_CARD 334 0 64 13 0xF3F4F6 ${RD_LINE}
    !insertmacro RD_TEXT_CENTER 334 3 64 8 "第 1 / 3 步" $RdFontChip ${RD_MUTED}
  ${EndIf}
FunctionEnd

; 一张环境卡片：底色 + 描边 + 状态圆点 + 标题 + 小号值
; 卡片 190×32，两列正好铺满 400u（0/210），两行之间留 6u。
!macro RD_ENV_CARD X Y TITLE DOT VAL
  Push $0
  Push $1
  !insertmacro RD_CARD ${X} ${Y} 190 32 ${RD_FILL} ${RD_LINE}

  IntOp $0 ${X} + 9
  IntOp $1 ${Y} + 5
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}" "${WS_EX_TRANSPARENT}" $0u $1u 10u 12u "●"
  Pop ${DOT}
  SendMessage ${DOT} ${WM_SETFONT} $RdFontSmall 1
  SetCtlColors ${DOT} ${RD_FAINT} transparent
  !insertmacro RD_TO_FRONT ${DOT}

  IntOp $0 ${X} + 22
  IntOp $1 ${Y} + 5
  !insertmacro RD_TEXT $0 $1 160 11 "${TITLE}" $RdFontBold ${RD_INK}

  IntOp $1 ${Y} + 18
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_ENDELLIPSIS}" "${WS_EX_TRANSPARENT}" $0u $1u 160u 11u ""
  Pop ${VAL}
  SendMessage ${VAL} ${WM_SETFONT} $RdFontTiny 1
  SetCtlColors ${VAL} ${RD_MUTED} transparent
  !insertmacro RD_TO_FRONT ${VAL}

  Pop $1
  Pop $0
!macroend

; ============================================================================
; 环境显示刷新（检测已经在 DetectEnvironment 里完成）
; ============================================================================

Function RdRefreshEnv
  ${If} $RdInstalled == 1
    ${If} $EnvAllOk == "1"
      ${NSD_SetText} $RdCtlEnvLineDot "✓"
      SetCtlColors $RdCtlEnvLineDot ${RD_GREEN} transparent
      ${NSD_SetText} $RdCtlEnvLineText "环境检查通过 · $EnvOsTiny · $EnvArchShort · $EnvSpaceShort"
      SetCtlColors $RdCtlEnvLineText ${RD_MUTED} transparent
    ${Else}
      ${NSD_SetText} $RdCtlEnvLineDot "✗"
      SetCtlColors $RdCtlEnvLineDot ${RD_RED} transparent
      ${NSD_SetText} $RdCtlEnvLineText "环境检查未通过，请重新检测或确认风险后继续"
      SetCtlColors $RdCtlEnvLineText ${RD_RED} transparent
    ${EndIf}
  ${Else}
    ${NSD_SetText} $RdCtlOsDot "●"
    ${NSD_SetText} $RdCtlOsVal "$EnvOsShort"
    ${If} $EnvOsOk == "1"
      SetCtlColors $RdCtlOsDot ${RD_GREEN} transparent
      SetCtlColors $RdCtlOsVal ${RD_MUTED} transparent
    ${Else}
      SetCtlColors $RdCtlOsDot ${RD_RED} transparent
      SetCtlColors $RdCtlOsVal ${RD_RED} transparent
    ${EndIf}

    ${NSD_SetText} $RdCtlArchDot "●"
    ${NSD_SetText} $RdCtlArchVal "$EnvArchShort"
    ${If} $EnvArchOk == "1"
      SetCtlColors $RdCtlArchDot ${RD_GREEN} transparent
      SetCtlColors $RdCtlArchVal ${RD_MUTED} transparent
    ${Else}
      SetCtlColors $RdCtlArchDot ${RD_RED} transparent
      SetCtlColors $RdCtlArchVal ${RD_RED} transparent
    ${EndIf}

    ${NSD_SetText} $RdCtlSpaceDot "●"
    ${NSD_SetText} $RdCtlSpaceVal "$EnvSpaceShort"
    ${If} $EnvSpaceOk == "1"
      SetCtlColors $RdCtlSpaceDot ${RD_GREEN} transparent
      SetCtlColors $RdCtlSpaceVal ${RD_MUTED} transparent
    ${Else}
      SetCtlColors $RdCtlSpaceDot ${RD_RED} transparent
      SetCtlColors $RdCtlSpaceVal ${RD_RED} transparent
    ${EndIf}

    ${NSD_SetText} $RdCtlDirDot "●"
    ${NSD_SetText} $RdCtlDirVal "$EnvDirShort"
    ${If} $EnvDirOk == "1"
      SetCtlColors $RdCtlDirDot ${RD_GREEN} transparent
      SetCtlColors $RdCtlDirVal ${RD_MUTED} transparent
    ${Else}
      SetCtlColors $RdCtlDirDot ${RD_RED} transparent
      SetCtlColors $RdCtlDirVal ${RD_RED} transparent
    ${EndIf}
  ${EndIf}

  Call RdUpdateForce
FunctionEnd

Function RdUpdateForce
  ${If} $EnvAllOk == "1"
    ShowWindow $RdCtlForce ${SW_HIDE}
  ${Else}
    ShowWindow $RdCtlForce ${SW_SHOW}
  ${EndIf}
FunctionEnd

; ============================================================================
; 页面按钮
; ============================================================================

Function PrepRetest
  Pop $0
  Call DetectEnvironment
  Call RdRefreshEnv
FunctionEnd

Function PrepBrowse
  Pop $0
  ${NSD_GetText} $RdCtlPath $0
  nsDialogs::SelectFolderDialog "选择安装位置" "$0"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    ${NSD_SetText} $RdCtlPath "$0"
  ${EndIf}
FunctionEnd

; ============================================================================
; 页面创建
; ============================================================================

Function PrepPageCreate
  Call DetectEnvironment

  ${If} $RdInstalled == 1
    ; 强制当前用户安装时，安装模式页会重置 $INSTDIR；这里恢复升级目标
    ${If} $RdOldDir != ""
      StrCpy $INSTDIR "$RdOldDir"
    ${EndIf}
  ${EndIf}

  ; 顺序固定：撑大窗口骨架 → 建子对话框 → 把子对话框对齐目标尺寸 → 排版。
  ; 页内控件的坐标是 DLU，按当时对话框的实际像素换算，所以必须晚于 stretch。
  Call RdGrowDialog

  nsDialogs::Create 1018
  Pop $RdDlg
  ${If} $RdDlg == error
    Abort
  ${EndIf}
  Call RdStretchDlg

  Call RdMakeFonts
  StrCpy $RdStep 0
  Call RdDrawStepper

  ${If} $RdInstalled == 1
    ${If} $RdOldVersion == "${VERSION}"
      StrCpy $RdHeaderTitle "准备重新安装 Keyper"
      StrCpy $RdHeaderSub "覆盖同版本程序文件，连接配置与设置保留。"
    ${Else}
      StrCpy $RdHeaderTitle "准备升级 Keyper"
      StrCpy $RdHeaderSub "原安装目录与配置会自动保留。"
    ${EndIf}
  ${Else}
    StrCpy $RdHeaderTitle "准备安装 Keyper"
    StrCpy $RdHeaderSub "当前用户安装，无需管理员权限。"
  ${EndIf}
  Call RdApplyHeader

  ${If} $RdInstalled == 1
    ; ---------------- 升级形态 ----------------
    ; 画布 400×210，升级页内容比全新页少两块卡片，段间距相应放大以免下方留白。
    !insertmacro RD_CARD 0 14 ${RD_PAGE_W} 22 ${RD_BRAND_SOFT} ${RD_BRAND_LINE}
    !insertmacro RD_PANEL 0 14 2 22 ${RD_BRAND} $RdCtlScratch

    ${If} $RdOldVersion == ""
      !insertmacro RD_TEXT 10 20 380 11 "升级到 ${VERSION}" $RdFontBold ${RD_BRAND}
    ${ElseIf} $RdOldVersion == "${VERSION}"
      !insertmacro RD_TEXT 10 20 380 11 "重新安装 ${VERSION}" $RdFontBold ${RD_BRAND}
    ${Else}
      !insertmacro RD_TEXT 10 20 380 11 "$RdOldVersion → ${VERSION}" $RdFontBold ${RD_BRAND}
    ${EndIf}

    !insertmacro RD_TEXT 0 46 200 10 "运行环境" $RdFontSection ${RD_INK}
    !insertmacro RD_LINK_RIGHT 300 46 96 11 "重新检测" $RdFontTiny PrepRetest

    nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}" "${WS_EX_TRANSPARENT}" 2u 62u 10u 12u ""
    Pop $RdCtlEnvLineDot
    SendMessage $RdCtlEnvLineDot ${WM_SETFONT} $RdFontSmall 1
    SetCtlColors $RdCtlEnvLineDot ${RD_FAINT} transparent
    !insertmacro RD_TO_FRONT $RdCtlEnvLineDot

    nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_ENDELLIPSIS}" "${WS_EX_TRANSPARENT}" 16u 63u 378u 11u ""
    Pop $RdCtlEnvLineText
    SendMessage $RdCtlEnvLineText ${WM_SETFONT} $RdFontSmall 1
    SetCtlColors $RdCtlEnvLineText ${RD_MUTED} transparent
    !insertmacro RD_TO_FRONT $RdCtlEnvLineText

    !insertmacro RD_RULE 86 ${RD_LINE}

    !insertmacro RD_TEXT 0 87 200 10 "安装位置" $RdFontSection ${RD_INK}
    !insertmacro RD_CARD 0 103 330 16 0xFFFFFF ${RD_BORDER}
    !insertmacro RD_TEXT_PATH 4 106 322 11 "$INSTDIR" $RdFontSmall ${RD_MUTED}
    !insertmacro RD_CARD 340 103 54 16 ${RD_GREEN_SOFT} ${RD_GREEN_LINE}
    !insertmacro RD_TEXT_CENTER 340 106 54 10 "已锁定" $RdFontChip ${RD_GREEN}

    !insertmacro RD_RULE 128 ${RD_LINE}

    !insertmacro RD_TEXT 0 129 260 10 "快捷方式与完成后" $RdFontSection ${RD_INK}

    ${NSD_CreateCheckbox} 0 145u 190u 13u "创建桌面快捷方式"
    Pop $RdCtlDesktop
    ${NSD_CreateCheckbox} 200u 145u 190u 13u "创建开始菜单快捷方式"
    Pop $RdCtlStartMenu
    ${NSD_CreateCheckbox} 0 164u 300u 13u "安装完成后启动 Keyper"
    Pop $RdCtlLaunch
  ${Else}
    ; ---------------- 全新安装形态 ----------------
    !insertmacro RD_RULE 14 ${RD_LINE}

    !insertmacro RD_TEXT 0 15 200 10 "运行环境" $RdFontSection ${RD_INK}
    !insertmacro RD_LINK_RIGHT 300 15 96 11 "重新检测" $RdFontTiny PrepRetest

    !insertmacro RD_ENV_CARD 0 29 "操作系统" $RdCtlOsDot $RdCtlOsVal
    !insertmacro RD_ENV_CARD 210 29 "系统架构" $RdCtlArchDot $RdCtlArchVal
    !insertmacro RD_ENV_CARD 0 65 "磁盘空间" $RdCtlSpaceDot $RdCtlSpaceVal
    !insertmacro RD_ENV_CARD 210 65 "目标目录" $RdCtlDirDot $RdCtlDirVal

    !insertmacro RD_RULE 103 ${RD_LINE}

    !insertmacro RD_TEXT 0 104 200 10 "安装位置" $RdFontSection ${RD_INK}
    !insertmacro RD_CARD 0 119 300 16 0xFFFFFF ${RD_BORDER}

    nsDialogs::CreateControl EDIT "${DEFAULT_STYLES}|${WS_TABSTOP}|${ES_AUTOHSCROLL}" "0" 4u 121u 292u 12u "$INSTDIR"
    Pop $RdCtlPath
    SendMessage $RdCtlPath ${WM_SETFONT} $RdFontSmall 1
    !insertmacro RD_TO_FRONT $RdCtlPath

    !insertmacro RD_BUTTON 310 118 86 18 "更改…" $RdFontSmall PrepBrowse

    !insertmacro RD_RULE 142 ${RD_LINE}

    !insertmacro RD_TEXT 0 143 260 10 "快捷方式与完成后" $RdFontSection ${RD_INK}

    ${NSD_CreateCheckbox} 0 157u 190u 13u "创建桌面快捷方式"
    Pop $RdCtlDesktop
    ${NSD_CreateCheckbox} 200u 157u 190u 13u "创建开始菜单快捷方式"
    Pop $RdCtlStartMenu
    ${NSD_CreateCheckbox} 0 173u 190u 13u "安装完成后启动 Keyper"
    Pop $RdCtlLaunch
    ${NSD_CreateCheckbox} 200u 173u 190u 13u "将安装目录加入用户 PATH"
    Pop $RdCtlPathOpt
  ${EndIf}

  ; 勾选框统一字体（两个分支都创建了前三个）
  SendMessage $RdCtlDesktop ${WM_SETFONT} $RdFontSmall 1
  SendMessage $RdCtlStartMenu ${WM_SETFONT} $RdFontSmall 1
  SendMessage $RdCtlLaunch ${WM_SETFONT} $RdFontSmall 1
  !insertmacro RD_TO_FRONT $RdCtlDesktop
  !insertmacro RD_TO_FRONT $RdCtlStartMenu
  !insertmacro RD_TO_FRONT $RdCtlLaunch
  ${If} $RdInstalled != 1
    SendMessage $RdCtlPathOpt ${WM_SETFONT} $RdFontSmall 1
    !insertmacro RD_TO_FRONT $RdCtlPathOpt
  ${EndIf}

  ; 恢复上次勾选（页面通常只进一次，但取消/返回重进时保持一致）
  ${NSD_SetState} $RdCtlDesktop $RdOptDesktop
  ${NSD_SetState} $RdCtlStartMenu $RdOptStartMenu
  ${NSD_SetState} $RdCtlLaunch $RdOptLaunch
  ${If} $RdInstalled != 1
    ${NSD_SetState} $RdCtlPathOpt $RdOptPath
  ${EndIf}

  ${NSD_CreateCheckbox} 0 190u ${RD_PAGE_W}u 13u "我了解上述风险，仍然继续安装"
  Pop $RdCtlForce
  SendMessage $RdCtlForce ${WM_SETFONT} $RdFontSmall 1
  !insertmacro RD_TO_FRONT $RdCtlForce

  Call RdRefreshEnv

  ; 「下一步」文案按场景切换（按钮属于外层向导窗口）
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $RdInstalled == 1
    ${If} $RdOldVersion == "${VERSION}"
      SendMessage $0 ${WM_SETTEXT} 0 "STR:重新安装"
    ${Else}
      SendMessage $0 ${WM_SETTEXT} 0 "STR:开始升级"
    ${EndIf}
  ${Else}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:安装"
  ${EndIf}

  ; 本页是第一屏（安装模式页在运行时被跳过），「上一步」没有可回退的页面
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0

  nsDialogs::Show
FunctionEnd

; ============================================================================
; 页面离开：落定 $INSTDIR、保存勾选、重新检测最终路径
; ============================================================================

Function PrepPageLeave
  ${If} $RdInstalled != 1
    ${NSD_GetText} $RdCtlPath $0

    ; 去掉尾部分隔符（C:\Keyper\ → C:\Keyper）
    rd_pl_trim:
      StrCpy $1 $0 1 -1
      ${If} $1 == "\"
        StrCpy $0 $0 -1
        Goto rd_pl_trim
      ${EndIf}

    ${If} $0 == ""
      MessageBox MB_ICONEXCLAMATION|MB_OK "请填写安装位置。"
      Abort
    ${EndIf}

    ; 只接受盘符路径（C:\...）或 UNC 路径（\\server\share）
    StrCpy $1 $0 1
    StrCpy $2 $0 1 1
    ${If} $1 == "\"
      ${If} $2 != "\"
        MessageBox MB_ICONEXCLAMATION|MB_OK "安装位置必须是完整路径，例如 D:\Program Files\Keyper。"
        Abort
      ${EndIf}
    ${Else}
      ${If} $2 != ":"
        MessageBox MB_ICONEXCLAMATION|MB_OK "安装位置必须是完整路径，例如 D:\Program Files\Keyper。"
        Abort
      ${EndIf}
    ${EndIf}

    ; 自动补全应用子目录：用户选 C:\Apps 时实际装到 C:\Apps\Keyper
    StrLen $2 "${APP_FILENAME}"
    StrLen $3 $0
    IntOp $3 $3 - $2
    ${If} $3 >= 1
      StrCpy $4 $0 "" $3
      IntOp $5 $3 - 1
      StrCpy $6 $0 1 $5
      ${If} $4 == "${APP_FILENAME}"
      ${AndIf} $6 == "\"
        Goto rd_pl_dir_ok
      ${EndIf}
    ${EndIf}
    StrCpy $0 "$0\${APP_FILENAME}"
    rd_pl_dir_ok:

    StrCpy $INSTDIR "$0"

    ${NSD_GetState} $RdCtlDesktop $RdOptDesktop
    ${NSD_GetState} $RdCtlStartMenu $RdOptStartMenu
    ${NSD_GetState} $RdCtlLaunch $RdOptLaunch
    ${NSD_GetState} $RdCtlPathOpt $RdOptPath
  ${Else}
    ${NSD_GetState} $RdCtlDesktop $RdOptDesktop
    ${NSD_GetState} $RdCtlStartMenu $RdOptStartMenu
    ${NSD_GetState} $RdCtlLaunch $RdOptLaunch
    StrCpy $RdOptPath ${BST_UNCHECKED}
  ${EndIf}

  ; 路径可能在离开前刚被改过：重新检测磁盘与写入权限
  Call DetectEnvironment
  Call RdRefreshEnv

  ${If} $EnvBlocking == "1"
    MessageBox MB_ICONSTOP|MB_OK "本安装包仅支持 64 位 Windows，无法继续安装。"
    Abort
  ${EndIf}

  ${If} $EnvAllOk == "0"
    ${NSD_GetState} $RdCtlForce $0
    ${If} $0 != ${BST_CHECKED}
      MessageBox MB_ICONEXCLAMATION|MB_OK "环境检查有未通过项。$\r$\n$\r$\n如确认继续，请勾选下方「我了解上述风险，仍然继续安装」。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; 安装进度页的头部按场景切换（MUI_PAGE_CUSTOMFUNCTION_SHOW 在页面创建后调用）
; 这一页由模板创建，没有 nsDialogs 内页，但同样要重放放大：NSIS 每次进页
; 都会把内页占位、分隔线、页脚与按钮摆回模板尺寸。
Function RdInstFilesShow
  Call RdGrowBuiltinPage

  ${If} $RdInstalled == 1
    ${If} $RdOldVersion == "${VERSION}"
      StrCpy $RdHeaderTitle "正在重新安装 Keyper"
      StrCpy $RdHeaderSub "第 2 步，共 3 步 · 正在覆盖同版本程序文件，请勿关闭此窗口。"
    ${Else}
      StrCpy $RdHeaderTitle "正在升级 Keyper"
      StrCpy $RdHeaderSub "第 2 步，共 3 步 · 正在覆盖旧版本，连接配置会自动保留。"
    ${EndIf}
  ${Else}
    StrCpy $RdHeaderTitle "正在安装 Keyper"
    StrCpy $RdHeaderSub "第 2 步，共 3 步 · 正在写入程序文件，请勿关闭此窗口。"
  ${EndIf}
  Call RdApplyHeader
FunctionEnd

!endif
