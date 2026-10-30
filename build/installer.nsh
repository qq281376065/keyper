; ============================================================================
; Keyper — 安装器定制入口
; ============================================================================
; electron-builder 通过 nsis.include 引入本文件，并按约定调用以下宏：
;
;   customWelcomePage        —— **替代**内置欢迎页（不是追加）
;   customPageAfterChangeDir —— 目录页之后、开始安装之前的插入点
;   customInit               —— .onInit 内部
;   customInstall            —— 安装段末尾
;   customUnInstall          —— 卸载段
;
; ----------------------------------------------------------------------------
; 页面顺序（顺序本身有语义）：
;
;   欢迎 → [许可] → [安装模式] → 目录选择 → **环境检查** → 安装 → 完成
;
; 环境检查必须排在目录选择之后：目录页会在 instFilesPre 里改写 $INSTDIR
; （自动补全应用子目录名）；检查页若在前，磁盘空间与写入权限
; 测的就是用户最终并不会使用的路径 —— 测了等于没测。
; 为此使用官方钩子 customPageAfterChangeDir，而不是 customWelcomePage。
; ============================================================================

!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "WordFunc.nsh"
; 开始菜单勾选页需要 nsDialogs 的 NSD_* 控件宏与 BST_CHECKED 状态常量
!include "nsDialogs.nsh"

; 注意：这里**不要** !include "StrContains.nsh"。
; 本文件会被安装器与卸载器各编译一次，而 StrContains 函数只在安装段调用，
; 卸载器那趟会报 warning 6010（函数未引用）；electron-builder 把 NSIS
; 警告当错误处理，于是整次打包直接失败。PATH 判重改用 WordReplace 完成。

/*
 * 环境检查页的函数与变量。
 *
 * 必须在**顶层** include，不能塞进 customHeader 宏里：
 * electron-builder 是把本文件拼在安装主脚本的最前面（scriptGenerator + originalScript），
 * 此时尚在顶层作用域；而 customHeader 是在主脚本内部被 !insertmacro 展开的，
 * 在宏体内再 !include 定义 Function，展开时机与 Var 声明顺序都不可靠 ——
 * 实测结果是函数虽然定义了却"未被引用"，检查页根本没进安装流程。
 */
!include "${BUILD_RESOURCES_DIR}\installer-env.nsh"

/*
 * 已安装检测与升级。
 * 同样必须在顶层 include：它定义了 Var 与 Function，塞进宏里声明时机不可靠
 * （原因同上面 installer-env.nsh 的注释）。
 *
 * 依赖 ${UNINSTALL_APP_KEY} / ${APP_FILENAME} / ${APP_EXECUTABLE_FILENAME}，
 * 这些由 electron-builder 在拼接本文件之前就已定义好。
 */
!include "${BUILD_RESOURCES_DIR}\installer-upgrade.nsh"

/*
 * 用户配置的保留与清理（升级保留 config、卸载可选清理）。
 * 同样在顶层 include：它定义了 Var 与 customRemoveFiles 宏。
 */
!include "${BUILD_RESOURCES_DIR}\installer-config.nsh"

; 自定义 Var 必须声明在所有 Section / Function 之前
Var RdPrevPath
Var RdNewPath

; ---------------------------------------------------------------------------
; 开始菜单快捷方式 · 安装时勾选（2026-10 用户需求，默认勾选）
;
; electron-builder 25.1.8 的 assisted 安装器没有快捷方式勾选框机制：
; createStartMenuShortcut 只能「总是静默创建」(true) 或「不创建」(false)。
; 因此 electron-builder.yml 里设为 false 关掉默认创建，由本节接管：
;
;   勾选页（ShortcutsPageCreate）→ 状态存 $RdSmChecked
;   → customInstall 按 ${BST_CHECKED} 创建（路径与默认机制完全一致：
;      $SMPROGRAMS\${SHORTCUT_NAME}.lnk，AUMI 同 ${APP_ID}，卸载分组不破坏）
;   → customUnInstall 对称清理（默认卸载清理已被 false 关闭，必须自理）
;
; 静默安装（升级流程内部、/S 参数）：SilentInstall 下 custom 页自动跳过，
; $RdSmChecked 保持 customInit 里设置的初始值 1（勾选）→ 照常创建，
; 与「默认勾选」语义一致。
;
; 页面函数与页面专属变量都必须用 !ifndef BUILD_UNINSTALLER 包裹：本文件被
; 安装器与卸载器各编译一次，安装侧专属的东西出现在卸载趟会触发 NSIS 警告
; （函数未引用 = 6010，变量未引用 = 6001），而 electron-builder 把警告当
; 错误，整次打包直接失败。
;
; ⚠ Var 声明**不**是「两趟都安全」—— 卸载趟不展开 customInit/customInstall，
;   这三个变量在卸载趟零引用，照样报 warning 6001。实测踩过，别再挪出去。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
Var RdSmChecked
Var RdSmDlg
Var RdSmCheckbox
Function ShortcutsPageCreate
  ; 页面标题由 customPageAfterChangeDir 宏在 Page 声明前用
  ; MUI_PAGE_HEADER_TEXT 指定（同环境检查页的做法）。

  nsDialogs::Create 1018
  Pop $RdSmDlg
  ${If} $RdSmDlg == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 6u 100% 12u "创建开始菜单快捷方式"
  Pop $RdSmCheckbox
  ${NSD_SetState} $RdSmCheckbox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function ShortcutsPageLeave
  ${NSD_GetState} $RdSmCheckbox $RdSmChecked
FunctionEnd
!endif

; WordFunc.nsh 用 !define 把 ${WordReplace} 定义为插入宏的别名，
; include 后即可直接使用，不要再 !insertmacro 它（没有 WordReplaceCall 这个入口）

/*
 * 环境检查页的插入点：customPageAfterChangeDir
 *
 * 为什么不用 customWelcomePage：
 * 那个宏在 assistedInstaller.nsh 里是最先被展开的，用来**替代**默认欢迎页；
 * 而安装目录页（MUI_PAGE_DIRECTORY）在它之后，且目录页会在
 * instFilesPre 里改写 $INSTDIR（自动补全应用子目录名）。
 * 若把检查页放在欢迎页位置，磁盘空间与写入权限测的是用户最终不会用的路径。
 *
 * customPageAfterChangeDir 是 electron-builder 官方预留的钩子，注释写明
 * "after change installation directory and before install start" ——
 * 此时 $INSTDIR 已是最终值，正好适合做磁盘与写入权限检测。
 */
!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "环境检查"
  !define MUI_PAGE_HEADER_SUBTEXT "确认系统满足运行条件后再继续安装"
  Page custom EnvPageCreate EnvPageLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT

  ; 开始菜单快捷方式勾选页：排在环境检查之后 —— 检查通过才问用户
  ; 要什么附加选项；「下一步」即进入安装页，勾选结果立即可见。
  !define MUI_PAGE_HEADER_TEXT "附加选项"
  !define MUI_PAGE_HEADER_SUBTEXT "选择要创建的快捷方式"
  Page custom ShortcutsPageCreate ShortcutsPageLeave
  !undef MUI_PAGE_HEADER_TEXT
  !undef MUI_PAGE_HEADER_SUBTEXT
!macroend

!macro customInit
  ; 开始菜单勾选的默认值：勾选。必须在此初始化而不是依赖页面函数 ——
  ; 静默安装（升级流程 / /S）会跳过所有 custom 页，用户的「默认勾选」
  ; 语义只能靠这个初始值兜底。
  StrCpy $RdSmChecked "${BST_CHECKED}"

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
   *   · 升级时要改 $INSTDIR 回到原目录，只有在目录页创建之前改才生效；
   *   · 提示要在用户看到界面之前给出，否则他已经在目录页重选了路径。
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
     * 备份 <INSTDIR>\config：升级流程稍后会静默运行旧卸载器，
     * 旧卸载器会 RMDir /r $INSTDIR 连 config 一起删（0.0.6 及更早版本
     * 没有 customRemoveFiles 保护）。备份在 customInstall 里恢复。
     */
    !insertmacro RdBackupConfig
  ${EndIf}

  ; 告知用户本次是升级还是全新安装（静默安装下自动跳过）
  !insertmacro RdShowInstallNotice
!macroend

; ---------------------------------------------------------------------------
; 安装完成：把安装目录写入当前用户 PATH
;
; 三个必须遵守的细节：
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

  ; 开始菜单快捷方式：按「附加选项」页的勾选状态创建。
  ; 路径/AUMI 与 electron-builder 默认机制完全一致（$SMPROGRAMS\${SHORTCUT_NAME}.lnk
  ; + WinShell::SetLnkAUMI ${APP_ID}）—— 升级前的旧链接指向同一个位置，
  ; 任务栏分组与跳转列表不受影响；$appExe 在 Section 开头已赋值。
  ${If} $RdSmChecked == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  ReadRegStr $RdPrevPath HKCU "Environment" "Path"

  ${If} $RdPrevPath == ""
    StrCpy $RdNewPath "$INSTDIR"
  ${Else}
    StrCpy $RdNewPath ";$RdPrevPath;"
    ${WordReplace} "$RdNewPath" ";$INSTDIR;" ";" "+" $RdNewPath

    ; 替换后去掉首尾分号，得到规范形式
    StrCpy $RdNewPath $RdNewPath "" 1
    StrCpy $0 $RdNewPath -1
    ${If} $0 == ";"
      StrCpy $RdNewPath $RdNewPath -1
    ${EndIf}

    ; 判断是否本来就已存在：把结果再替换一次，长度变了说明刚才是命中的
    StrCpy $1 ";$RdNewPath;"
    ${WordReplace} "$1" ";$INSTDIR;" ";" "+" $1
    ${If} $1 == ";$RdNewPath;"
      ; 未命中 → 追加
      StrCpy $RdNewPath "$RdPrevPath;$INSTDIR"
    ${EndIf}
  ${EndIf}

  WriteRegExpandStr HKCU "Environment" "Path" "$RdNewPath"
  ; 广播环境变更：已打开的「运行」对话框与新开的 cmd 才能立刻识别
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

; ---------------------------------------------------------------------------
; 卸载：移除 PATH 条目与开始菜单快捷方式
;
; 不清理的话，卸载后 PATH 会留一条指向空目录的项目，
; 既轻微拖慢命令解析，也让用户以为没卸干净。
;
; 开始菜单快捷方式同理必须在此自理：electron-builder.yml 的
; createStartMenuShortcut: false 同时关闭了**卸载器**的默认清理
; （uninstaller.nsh 的 !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT 分支），
; 自定义勾选创建的链接若不删，卸载后会在开始菜单留下死链接。
; 用户没勾选安装时 Delete 落空（文件不存在）是幂等无害操作。
; ---------------------------------------------------------------------------
!macro customUnInstall
  ; 开始菜单快捷方式（安装时勾选创建的那个）
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
