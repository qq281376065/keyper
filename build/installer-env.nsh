; ============================================================================
; RedisDocter — 安装前的环境检查
; ============================================================================
;
; 设计前提（决定了"检查什么"）：
;
;   本应用是 Electron 应用，运行时（Node / Chromium / V8）全部随包携带；
;   ioredis、ssh2 也都是随包的库，主进程**不调用任何外部程序**。
;   因此传统的"检查 VC++ / .NET / Node.js"在这里是无效检查：
;   VC++ 运行库缺失也不影响 Electron 启动（它自带 libGLESv2 等 DLL）。
;   装一个只看不用的检查页只会增加点击，一个失败案例也拦不住。
;
;   真正会导致「装完打不开 / 用不了」的是系统条件：
;
;     1. Windows 版本 —— Electron 33 要求 Win10 1809（build 17763）及以上，
;        低版本直接闪退，用户看到的只是"双击没反应"，极难自查。
;     2. 系统位数 —— 本包只出 x64；32 位系统装上就是个无法运行的 exe。
;     3. 磁盘空间 —— 解压后约 400MB，空间不足会在解压中途失败，
;        留下半残目录，比直接拒绝更难收拾。
;     4. 目标目录可写 —— 无权限时写到一半失败。
;
;   页面位置很关键：必须放在**目录选择页之后**。
;   目录页会改写 $INSTDIR（补全应用子目录），若检查页在前，
;   磁盘空间与写入权限测的就是一个用户最终并未使用的路径 —— 等于白测。
; ============================================================================

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
; ${DriveSpace} 属于 FileFunc.nsh，不引入会在这里报 "!include: error in script"
!include "FileFunc.nsh"

; ---- 变量与函数都只属于安装器；卸载器编译时整体跳过 ----
; 不跳过的话卸载器那趟会报 warning 6001/6010（未引用），
; 而 electron-builder 把 NSIS 警告当错误，打包直接失败。
!ifndef BUILD_UNINSTALLER

; ------------------------------------------------------------------ 检测结果
Var EnvOsOk
Var EnvOsText
Var EnvArchOk
Var EnvArchText
Var EnvSpaceOk
Var EnvSpaceText
Var EnvDirOk
Var EnvDirText
Var EnvAllOk
Var EnvBlocking

; 页面控件
Var EnvDialog
Var EnvLine1
Var EnvLine2
Var EnvLine3
Var EnvLine4
Var EnvForceCheck

; ============================================================================
; 检测
; ============================================================================

Function ReadWindowsBuild
  StrCpy $0 "0"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $1 != ""
    StrCpy $0 $1
  ${EndIf}
FunctionEnd

Function ReadSystemBitness
  StrCpy $0 "x86"
  ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "PROCESSOR_ARCHITECTURE"
  ${If} $1 == "AMD64"
    StrCpy $0 "x64"
  ${ElseIf} $1 == "ARM64"
    StrCpy $0 "ARM64"
  ${EndIf}
FunctionEnd

; 目标盘可用空间（MB）→ $0
Function ReadFreeSpaceMB
  StrCpy $0 "0"
  StrCpy $1 $INSTDIR 1
  ${If} $1 != ""
    ${DriveSpace} "$1:\" "/D=F /S=M" $0
  ${EndIf}
FunctionEnd

; 目标目录可写性：写一个探针文件实测，而不是凭猜测
Function CheckDirWritable
  StrCpy $0 "0"
  ${If} $INSTDIR == ""
    Return
  ${EndIf}
  CreateDirectory "$INSTDIR"
  ClearErrors
  FileOpen $2 "$INSTDIR\.rd_probe" w
  ${If} ${Errors}
    Return
  ${EndIf}
  FileWrite $2 "probe"
  FileClose $2
  Delete "$INSTDIR\.rd_probe"
  StrCpy $0 "1"
FunctionEnd

Function DetectEnvironment
  ; ---- 1. Windows 版本 ----
  Call ReadWindowsBuild
  StrCpy $2 $0
  ${If} $2 == "0"
    StrCpy $EnvOsOk "0"
    StrCpy $EnvOsText "无法读取 Windows 版本号"
  ${ElseIf} $2 >= 17763
    StrCpy $EnvOsOk "1"
    ${If} $2 >= 22000
      StrCpy $EnvOsText "Windows 11（内部版本 $2）"
    ${Else}
      StrCpy $EnvOsText "Windows 10（内部版本 $2）"
    ${EndIf}
  ${Else}
    StrCpy $EnvOsOk "0"
    StrCpy $EnvOsText "版本过低（内部版本 $2，需 17763 及以上）"
  ${EndIf}

  ; ---- 2. 系统位数 ----
  Call ReadSystemBitness
  ${If} $0 == "x64"
    StrCpy $EnvArchOk "1"
    StrCpy $EnvArchText "64 位（x64）"
  ${Else}
    StrCpy $EnvArchOk "0"
    StrCpy $EnvArchText "系统为 $0，本安装包仅支持 64 位"
  ${EndIf}

  ; ---- 3. 磁盘空间 ----
  Call ReadFreeSpaceMB
  StrCpy $3 $0
  ${If} $3 >= 600
    StrCpy $EnvSpaceOk "1"
    IntOp $4 $3 / 1024
    StrCpy $EnvSpaceText "可用 $4 GB（需 600 MB）"
  ${Else}
    StrCpy $EnvSpaceOk "0"
    StrCpy $EnvSpaceText "仅 $3 MB 可用，需要至少 600 MB"
  ${EndIf}

  ; ---- 4. 目录可写 ----
  Call CheckDirWritable
  ${If} $0 == "1"
    StrCpy $EnvDirOk "1"
    StrCpy $EnvDirText "可写入"
  ${Else}
    StrCpy $EnvDirOk "0"
    StrCpy $EnvDirText "无写入权限"
  ${EndIf}

  ; ---- 汇总 ----
  StrCpy $EnvAllOk "1"
  StrCpy $EnvBlocking "0"
  ${If} $EnvOsOk == "0"
    StrCpy $EnvAllOk "0"
  ${EndIf}
  ${If} $EnvArchOk == "0"
    StrCpy $EnvAllOk "0"
    StrCpy $EnvBlocking "1"
  ${EndIf}
  ${If} $EnvSpaceOk == "0"
    StrCpy $EnvAllOk "0"
  ${EndIf}
  ${If} $EnvDirOk == "0"
    StrCpy $EnvAllOk "0"
  ${EndIf}
FunctionEnd

; ============================================================================
; 页面
; ============================================================================

Function EnvPageCreate
  ; 页面标题由 installer.nsh 在 Page 声明前用 MUI_PAGE_HEADER_TEXT 指定。
     ; 不能在函数体里 !insertmacro MUI_HEADER_TEXT —— 那是 MUI 在页面声明时
     ; 展开的宏，放在运行时函数里会直接编译报错。

  ; 每次进入都重测：用户可能刚在上一页改了安装目录
  Call DetectEnvironment

  nsDialogs::Create 1018
  Pop $EnvDialog
  ${If} $EnvDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "已自动检测以下系统条件："
  Pop $0
  CreateFont $1 "$(^Font)" "10" "700"
  SendMessage $0 ${WM_SETFONT} $1 1

  ${NSD_CreateLabel} 0 26u 100% 16u ""
  Pop $EnvLine1
  ${NSD_CreateLabel} 0 46u 100% 16u ""
  Pop $EnvLine2
  ${NSD_CreateLabel} 0 66u 100% 16u ""
  Pop $EnvLine3
  ${NSD_CreateLabel} 0 86u 100% 16u ""
  Pop $EnvLine4

  ${If} $EnvOsOk == "1"
    ${NSD_SetText} $EnvLine1 "✔ 操作系统：$EnvOsText"
    SetCtlColors $EnvLine1 0x1a7f37 transparent
  ${Else}
    ${NSD_SetText} $EnvLine1 "✖ 操作系统：$EnvOsText"
    SetCtlColors $EnvLine1 0xc0392b transparent
  ${EndIf}

  ${If} $EnvArchOk == "1"
    ${NSD_SetText} $EnvLine2 "✔ 系统位数：$EnvArchText"
    SetCtlColors $EnvLine2 0x1a7f37 transparent
  ${Else}
    ${NSD_SetText} $EnvLine2 "✖ 系统位数：$EnvArchText"
    SetCtlColors $EnvLine2 0xc0392b transparent
  ${EndIf}

  ${If} $EnvSpaceOk == "1"
    ${NSD_SetText} $EnvLine3 "✔ 磁盘空间：$EnvSpaceText"
    SetCtlColors $EnvLine3 0x1a7f37 transparent
  ${Else}
    ${NSD_SetText} $EnvLine3 "✖ 磁盘空间：$EnvSpaceText"
    SetCtlColors $EnvLine3 0xc0392b transparent
  ${EndIf}

  ${If} $EnvDirOk == "1"
    ${NSD_SetText} $EnvLine4 "✔ 安装目录：$EnvDirText（$INSTDIR）"
    SetCtlColors $EnvLine4 0x1a7f37 transparent
  ${Else}
    ${NSD_SetText} $EnvLine4 "✖ 安装目录：$EnvDirText（$INSTDIR）"
    SetCtlColors $EnvLine4 0xc0392b transparent
  ${EndIf}

  ${NSD_CreateLabel} 0 114u 100% 58u "本程序自带完整运行环境（Electron 运行时、Redis 客户端、SSH 隧道），$\r$\n无需另外安装 Node.js、.NET 或 VC++ 运行库。$\r$\n安装完成后可直接运行，通过「新建连接」填写 Redis 地址即可使用。$\r$\n安装目录会被加入当前用户的 PATH 环境变量。"
  Pop $0
  SetCtlColors $0 0x666666 transparent

  ${If} $EnvAllOk == "0"
    ${If} $EnvBlocking == "1"
      ${NSD_CreateLabel} 0 178u 100% 32u "当前系统不满足最低运行条件，安装后程序无法启动。$\r$\n请改用 64 位 Windows 重新安装。"
      Pop $0
      SetCtlColors $0 0xc0392b transparent
    ${Else}
      ${NSD_CreateCheckbox} 0 178u 100% 14u "我了解上述风险，仍然继续安装"
      Pop $EnvForceCheck
      ${NSD_Uncheck} $EnvForceCheck
    ${EndIf}
  ${Else}
    ${NSD_CreateLabel} 0 178u 100% 16u "✓ 全部检查通过，可以继续。"
    Pop $0
    SetCtlColors $0 0x1a7f37 transparent
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function EnvPageLeave
  ${If} $EnvBlocking == "1"
    MessageBox MB_ICONSTOP|MB_OK "当前系统为 32 位，无法运行本程序。安装已中止。"
    Abort
  ${EndIf}

  ${If} $EnvAllOk == "0"
    ${NSD_GetState} $EnvForceCheck $0
    ${If} $0 != ${BST_CHECKED}
      MessageBox MB_ICONEXCLAMATION|MB_OK "环境检查有未通过项。$\r$\n$\r$\n如确认继续，请勾选「我了解上述风险，仍然继续安装」。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif