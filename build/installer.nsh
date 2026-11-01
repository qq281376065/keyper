; ============================================================================
; Keyper — 安装器定制入口
; ============================================================================
; electron-builder 通过 nsis.include 引入本文件，并按约定调用以下宏：
;
;   customInstallMode        —— 安装模式页创建前（本包固定为当前用户）
;   customPageAfterChangeDir —— 目录页之后、开始安装之前的插入点
;   customFinishPage         —— 替代内置完成页
;   customInit               —— .onInit 内部
;   customInstall            —— 安装段末尾
;   customUnInstall          —— 卸载段
;   customUnWelcomePage      —— 替代卸载欢迎页（卸载选项页）
;   customUninstallPage      —— 卸载进度页之后（自定义卸载完成页）
;   customUnInit             —— 卸载器 .onInit
;
; ----------------------------------------------------------------------------
; 页面顺序（方案 B：三段向导）：
;
;   安装： 准备（环境 / 路径 / 选项）→ 正在安装 → 完成
;   卸载： 卸载选项（保留 / 删除配置）→ 正在卸载 → 完成
;
; electron-builder.yml 已关闭内置目录页，因此「准备」页是用户看到的第一屏；
; 安装模式页由 customInstallMode 跳过（固定当前用户安装，不请求管理员权限）。
; ============================================================================

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "WordFunc.nsh"
!include "nsDialogs.nsh"

; ---------------------------------------------------------------------------
; 自定义 Var 必须声明在所有 Section / Function 之前（下面 include 的文件
; 会在顶层定义函数，所以先声明本文件的变量）。
; ---------------------------------------------------------------------------
Var RdPrevPath
Var RdNewPath

; 主题宏的临时句柄；安装器与卸载器两趟都会展开主题宏，所以声明在这里。
Var RdCtlScratch

; 以下两个只在安装器趟使用；卸载器趟没有 customInit/customInstall，
; 声明了却零引用会吃 warning 6001（electron-builder 把警告当错误）。
!ifndef BUILD_UNINSTALLER
Var RdPathWasPresent     ; 升级前用户 PATH 里是否已有安装目录
Var RdPathEnsure         ; 本次安装是否应确保 PATH 含安装目录
!endif

/*
 * 顶层 include 的顺序就是符号可用性依赖的顺序：
 *   env      → 安装器环境检测（Install 侧 Var/Function）
 *   upgrade  → 已安装检测 / 升级目录（Install 侧）
 *   config   → 配置备份恢复 + customRemoveFiles 宏（两趟都参与）
 *   theme    → 色块/描边/文字/圆形宏（两趟都参与）
 *   resize   → 运行时窗体放大（依赖 theme 的 RD_PAGE_*，两趟都参与）
 *   prep     → 安装准备页（Install 侧）
 *   finish   → 安装完成页（Install 侧）
 *   uninstall→ 卸载选项/完成页（Uninstall 侧）
 *
 * installer-env / installer-upgrade 只能在顶层 include：它们定义 Var 与
 * Function，塞进宏里展开的时机与声明顺序都不可靠（实测函数会"未被引用"）。
 * 每个文件内部都用 !ifndef/!ifdef BUILD_UNINSTALLER 做了隔离，避免另一趟
 * 编译时出现 warning 6001/6010 —— electron-builder 用 -WX 把警告当错误。
 */
!include "${BUILD_RESOURCES_DIR}\installer-env.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-upgrade.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-config.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-theme.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-resize.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-prep.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-finish.nsh"
!include "${BUILD_RESOURCES_DIR}\installer-uninstall.nsh"

; ---------------------------------------------------------------------------
; 窗口标题见 installer-resize.nsh 的 RdGrowDialog：
; makensis v3.04 不认 WindowName 命令（实测 Invalid command），只能运行时发
; WM_SETTEXT；卸载器默认标题取自简体中文语言包 2010 版的「解除安装」，
; 与页内一律使用的「卸载」对不上，需要覆盖。
; ---------------------------------------------------------------------------

; ---------------------------------------------------------------------------
; 固定「当前用户安装」
;
; 本包 perMachine=false，启动时不请求管理员权限。electron-builder 的模式页
; 在多用户环境下会先问"为谁安装"，与三段向导的第一屏重复；这里强制当前
; 用户并 Abort，让模板跳过该页（multiUserUi.nsh 的 $isForceCurrentInstall 分支）。
;
; 卸载器不强制：模板在"只存在当前用户安装"时会自动跳过模式页；
; 若旧版本曾被装成机器级，强行切到当前用户会把 $INSTDIR 指到默认目录，
; 反而卸错位置。
; ---------------------------------------------------------------------------
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

; ---------------------------------------------------------------------------
; 安装准备页（三段向导第 1 步）
;
; 环境检查放在这里而不是更早：用户可能在本页修改安装路径，离开时会重新
; 检测磁盘与写入权限。页面内部自己完成路径确定，随后模板的
; MUI_PAGE_INSTFILES 直接开始安装。
; ---------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom PrepPageCreate PrepPageLeave

  ; 给紧随其后的安装进度页设定标题；运行时 RdInstFilesShow 会按
  ; 「全新 / 升级」再改一次（见 installer-prep.nsh）。
  !define MUI_PAGE_HEADER_TEXT "正在安装 Keyper"
  !define MUI_PAGE_HEADER_SUBTEXT "第 2 步，共 3 步 · 正在写入程序文件，请勿关闭此窗口。"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW RdInstFilesShow
!macroend

!macro customInit
  ; 选项默认值：快捷方式默认创建，PATH 默认不修改（减少系统变更）。
  ; 静默安装（/S）不会创建任何页面，用户没有机会改，所以必须在这里兜底。
  StrCpy $RdOptDesktop ${BST_CHECKED}
  StrCpy $RdOptStartMenu ${BST_CHECKED}
  StrCpy $RdOptLaunch ${BST_CHECKED}
  StrCpy $RdOptPath ${BST_UNCHECKED}

  ; .onInit 阶段 $INSTDIR 还是初始值，此处的检测结果只用于
  ; 「32 位系统」这种与目录无关的硬性判断，避免用户一路点到安装才被拒。
  Call ReadSystemBitness
  ${If} $0 != "x64"
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "本安装包仅支持 64 位 Windows。$\r$\n当前系统为 $0，无法安装。"
      Quit
    ${EndIf}
  ${EndIf}

  /*
   * 已安装检测 → 决定走升级还是全新安装。
   *
   * 必须在 .onInit 里做，而不是等到安装段：
   *   · 升级时要改 $INSTDIR 回原目录，只有在这里改才来得及；
   *   · 配置备份也要在旧卸载器运行之前完成。
   */
  Call DetectInstalled

  ${If} $RdInstalled == 1
    /*
     * 升级：锁定原安装目录。
     *
     * 不锁的话，用户改到别处就变成"两份安装"：旧版本仍在原处、
     * 新版本装到新目录，快捷方式指向新的，程序和功能里出现两条记录。
     */
    !insertmacro RdApplyUpgradeDir

    /*
     * 记录升级前的 PATH 状态。
     *
     * 升级会静默运行旧卸载器，而卸载器会删除安装目录在用户 PATH 里的条目；
     * 新安装器的 PATH 选项在升级页不展示（也不能改），若不补回，
     * 用户原本可用的 keyper 命令会在升级后凭空消失。
     */
    StrCpy $RdPathWasPresent 0
    ReadRegStr $RdPrevPath HKCU "Environment" "Path"
    ${If} $RdPrevPath != ""
      StrCpy $RdPrevPath ";$RdPrevPath;"
      ${WordReplace} "$RdPrevPath" ";$INSTDIR;" ";" "+" $RdNewPath
      ${If} $RdNewPath != $RdPrevPath
        StrCpy $RdPathWasPresent 1
      ${EndIf}
    ${EndIf}

    /*
     * 备份 <INSTDIR>\config：升级流程稍后会静默运行旧卸载器，
     * 旧卸载器可能把 config 一起删掉（旧版本没有 customRemoveFiles 保护）。
     * 备份在 customInstall 里恢复。
     */
    !insertmacro RdBackupConfig

    ; 升级沿用旧安装的快捷方式状态：旧版本没有桌面图标就别凭空补一个。
    IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" rd_ci_desk_yes 0
      StrCpy $RdOptDesktop ${BST_UNCHECKED}
    rd_ci_desk_yes:
    IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" rd_ci_sm_yes 0
      StrCpy $RdOptStartMenu ${BST_UNCHECKED}
    rd_ci_sm_yes:
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 安装完成：按准备页的勾选创建快捷方式，按需写入用户 PATH
;
; PATH 的三个必须遵守的细节：
;
; 1. **用户级 PATH**（HKCU\Environment），不碰系统级。
;    本包 perMachine=false，是当前用户安装；改系统 PATH 需要额外提权，
;    而且会影响这台机器上其他账户。
;
; 2. 用 WriteRegExpandStr 写 REG_EXPAND_SZ。
;    用户 PATH 常含 %USERPROFILE% 之类变量，若用 REG_SZ 写回，
;    变量会被固化成绝对路径，换账户或改用户名后就失效了。
;
; 3. **幂等**：先判断是否已存在再加，否则重复安装会让 PATH 出现重复项
;    （PATH 过长会导致部分命令行工具直接报错）。
;
; 路径比较用「分号边界」而不是子串包含：
; PATH 里若已有 C:\Program Files\Keyper2，
; 子串包含会把 C:\Program Files\Keyper 误判为已存在，
; 结果新目录永远加不进去。
; ---------------------------------------------------------------------------
!macro customInstall
  ; 恢复配置目录：先接回卸载时保留的，再合并升级备份（顺序见宏内注释）
  !insertmacro RdRestoreConfig

  ; 桌面快捷方式
  ${If} $RdOptDesktop == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  ; 开始菜单快捷方式
  ${If} $RdOptStartMenu == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  ; PATH 的写入条件：
  ;   · 全新安装：只有用户勾选才写；
  ;   · 升级：不展示选项，按「保持现状」处理 —— 升级前有就补回，
  ;     升级前没有就不新增（旧卸载器已经把旧条目删掉了）。
  ${If} $RdOptPath == ${BST_CHECKED}
    StrCpy $RdPathEnsure 1
  ${ElseIf} $RdInstalled == 1
  ${AndIf} $RdPathWasPresent == 1
    StrCpy $RdPathEnsure 1
  ${Else}
    StrCpy $RdPathEnsure 0
  ${EndIf}

  ${If} $RdPathEnsure == 1
    ReadRegStr $RdPrevPath HKCU "Environment" "Path"

    ${If} $RdPrevPath == ""
      StrCpy $RdNewPath "$INSTDIR"
    ${Else}
      ; 用「;目录;」形式判断是否已存在，再做一次替换比较：
      ; 命中时结果变短，未命中时原样返回。按分号边界匹配，
      ; 不会把 C:\...\Keyper2 误判成 C:\...\Keyper。
      StrCpy $1 ";$RdPrevPath;"
      ${WordReplace} "$1" ";$INSTDIR;" ";" "+" $2
      ${If} $2 == $1
        StrCpy $RdNewPath "$RdPrevPath;$INSTDIR"
      ${Else}
        StrCpy $RdNewPath "$RdPrevPath"
      ${EndIf}
    ${EndIf}

    WriteRegExpandStr HKCU "Environment" "Path" "$RdNewPath"
    ; 广播环境变更：已打开的「运行」对话框与新开的 cmd 才能立刻识别
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 卸载：移除快捷方式与 PATH 条目
;
; 不清理的话，卸载后 PATH 会留一条指向空目录的项目，
; 既轻微拖慢命令解析，也让用户以为没卸干净。
;
; 快捷方式必须在此自理：electron-builder.yml 把 createDesktopShortcut /
; createStartMenuShortcut 都设为 false，模板的卸载清理分支
;（uninstaller.nsh 的 DO_NOT_CREATE_* 判断）会整段跳过。
; 用户没勾选时 Delete 落空（文件不存在）是幂等无害操作。
; ---------------------------------------------------------------------------
!macro customUnInstall
  WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  WinShell::UninstShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"

  ReadRegStr $RdPrevPath HKCU "Environment" "Path"
  ${If} $RdPrevPath != ""
    Push "$RdPrevPath"
    Push "$INSTDIR"
    Call un.RemovePathEntry
    Pop $RdNewPath

    WriteRegExpandStr HKCU "Environment" "Path" "$RdNewPath"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 按分号切分 PATH，逐段比对后重组，丢弃等于 $INSTDIR 的段。
;
; 为什么不用 WordReplace：
;   PATH 本身就是分号分隔，被替换串 ";dir;" 也含分号，
;   实测替换结果不符合预期（卸载后条目仍在）。
;   手写分段虽然啰嗦，但每一步都可验证，且天然按边界精确匹配，
;   不会把 Keyper 误伤成 Keyper2。
;
; 入栈：PATH、待移除目录 → 出栈：新 PATH
; 注意函数名带 un. 前缀：卸载器进程里普通函数不可用。
; ---------------------------------------------------------------------------
; un. 前缀函数只在卸载器那趟编译时允许出现，必须加条件
!ifdef BUILD_UNINSTALLER
Function un.RemovePathEntry
  Exch $0            ; 待移除目录
  Exch
  Exch $1            ; PATH 原文
  Push $2            ; 结果累积
  Push $3            ; 当前段
  Push $4            ; 游标
  Push $5            ; 当前字符

  StrCpy $2 ""
  StrCpy $4 0

  un_rpe_loop:
    StrCpy $5 $1 1 $4
    ${If} $5 == ""
      ; 末尾段（PATH 不以分号结尾）
      StrCpy $3 $1 "" $4
      ${If} $3 != ""
        ${If} $3 != $0
          ${If} $2 == ""
            StrCpy $2 "$3"
          ${Else}
            StrCpy $2 "$2;$3"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Goto un_rpe_done
    ${ElseIf} $5 == ";"
      StrCpy $3 $1 $4
      ; 空段不可靠（有些软件会写 ";;"），跳过即可
      ${If} $3 != ""
        ${If} $3 != $0
          ${If} $2 == ""
            StrCpy $2 "$3"
          ${Else}
            StrCpy $2 "$2;$3"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      IntOp $4 $4 + 1
      StrCpy $1 $1 "" $4
      StrCpy $4 0
      Goto un_rpe_loop
    ${EndIf}
    IntOp $4 $4 + 1
    Goto un_rpe_loop

  un_rpe_done:
    StrCpy $0 $2
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Exch $0
FunctionEnd
!endif
