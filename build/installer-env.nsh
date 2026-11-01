; ============================================================================
; Keyper — 安装前的环境检测（只检测，不出界面）
; ============================================================================
;
; 设计前提（决定了"检查什么"）：
;
;   本应用是 Electron 应用，运行时（Node / Chromium / V8）全部随包携带；
;   ioredis、ssh2 也都是随包的库，主进程**不调用任何外部程序**。
;   因此传统的"检查 VC++ / .NET / Node.js"在这里是无效检查：
;   VC++ 运行库缺失也不影响 Electron 启动（它自带 libGLESv2 等 DLL）。
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
;   检测结果由「准备」页（installer-prep.nsh）展示；本文件只负责算，
;   不在安装器里定义任何页面 —— 卸载器不需要这些检查。
; ============================================================================

!include "LogicLib.nsh"
; ${DriveSpace} 属于 FileFunc.nsh，不引入会在这里报 "!include: error in script"
!include "FileFunc.nsh"

; ---- 变量与函数都只属于安装器；卸载器编译时整体跳过 ----
; 不跳过的话卸载器那趟会报 warning 6001/6010（未引用），
; 而 electron-builder 把 NSIS 警告当错误（-WX），打包直接失败。
!ifndef BUILD_UNINSTALLER

; ------------------------------------------------------------------ 检测结果
Var EnvOsOk
Var EnvOsShort
Var EnvOsTiny
Var EnvArchOk
Var EnvArchShort
Var EnvSpaceOk
Var EnvSpaceShort
Var EnvDirOk
Var EnvDirShort
Var EnvAllOk
Var EnvBlocking

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

; 目标盘可用空间（MB）→ $0；网络路径返回 -1（不检测）
Function ReadFreeSpaceMB
  StrCpy $0 "0"
  StrCpy $1 $INSTDIR 1
  StrCpy $2 $INSTDIR 1 1
  ${If} $1 == "\"
    StrCpy $0 "-1"
  ${ElseIf} $2 == ":"
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
  ${If} $0 == "0"
    StrCpy $EnvOsOk "0"
    StrCpy $EnvOsShort "无法读取系统版本"
    StrCpy $EnvOsTiny "无法读取系统版本"
  ${ElseIf} $0 >= 17763
    StrCpy $EnvOsOk "1"
    ${If} $0 >= 22000
      StrCpy $EnvOsShort "Windows 11 · 内部版本 $0"
      StrCpy $EnvOsTiny "Windows 11"
    ${Else}
      StrCpy $EnvOsShort "Windows 10 · 内部版本 $0"
      StrCpy $EnvOsTiny "Windows 10"
    ${EndIf}
  ${Else}
    StrCpy $EnvOsOk "0"
    StrCpy $EnvOsShort "版本过低（内部版本 $0）"
    StrCpy $EnvOsTiny "版本过低"
  ${EndIf}

  ; ---- 2. 系统位数 ----
  Call ReadSystemBitness
  ${If} $0 == "x64"
    StrCpy $EnvArchOk "1"
    StrCpy $EnvArchShort "64 位（x64）"
  ${Else}
    StrCpy $EnvArchOk "0"
    StrCpy $EnvArchShort "$0（仅支持 64 位）"
  ${EndIf}

  ; ---- 3. 磁盘空间 ----
  Call ReadFreeSpaceMB
  ${If} $0 == "-1"
    StrCpy $EnvSpaceOk "1"
    StrCpy $EnvSpaceShort "网络位置，未检测剩余空间"
  ${ElseIf} $0 >= 600
    StrCpy $EnvSpaceOk "1"
    IntOp $1 $0 / 1024
    StrCpy $EnvSpaceShort "可用 $1 GB，需要 600 MB"
  ${Else}
    StrCpy $EnvSpaceOk "0"
    StrCpy $EnvSpaceShort "仅 $0 MB 可用，需要 600 MB"
  ${EndIf}

  ; ---- 4. 目录可写 ----
  Call CheckDirWritable
  ${If} $0 == "1"
    StrCpy $EnvDirOk "1"
    StrCpy $EnvDirShort "可写入"
  ${Else}
    StrCpy $EnvDirOk "0"
    StrCpy $EnvDirShort "无写入权限"
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

!endif
