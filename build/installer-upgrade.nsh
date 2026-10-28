; ============================================================================
; RedisDocter — 已安装检测与升级
; ============================================================================
;
; 目标行为：
;   安装器启动后，先判断本机是否已经装过 RedisDocter。
;     · 已安装 → 进入「升级模式」：沿用原安装目录，保留用户数据，提示版本变化
;     · 未安装 → 走全新安装：允许选目录，提示为首次安装
;
; 为什么要有这套逻辑（electron-builder 其实已经能覆盖安装）：
;   内置的 ${isUpdated} 判断是"安装写到一半时"才知道的，用户在界面上
;   完全感知不到区别 —— 目录页照样让他重选，选到别处就会留下两份安装。
;   这里在**欢迎页之前**就检测出来，把结论直接摆给用户：
;   升级就锁定原目录并禁止改路径，避免出现"同一台机器两份 RedisDocter"。
;
; 检测依据（为何以注册表为主、目录为辅）：
;   1. 卸载信息键（HKCU/HKLM 的 Uninstall 节点）—— 安装器自己写的，
;      带 DisplayVersion / InstallLocation，是唯一能拿到**旧版本号**的来源；
;   2. 兜底看默认安装目录下是否存在可执行文件 —— 用户手工删过注册表、
;      或从绿色版转过来时，靠目录也能识别出来，避免重复安装。
; ============================================================================

!include "LogicLib.nsh"

/*
 * ============================================================================
 * ⚠️ 本文件的符号可用性限制（打包时踩过两次，务必读完再改）
 * ============================================================================
 *
 * 本文件由 installer.nsh 在**顶层** include，而 electron-builder 把用户脚本
 * 拼在主脚本最前面。展开顺序是：「本文件 → common.nsh → ...」。
 *
 * 因此，这里**不能**使用任何由 common.nsh 定义的符号：
 *
 *   · !define APP_EXECUTABLE_FILENAME ...
 *     → common.nsh:16 再定义时报 "already defined"，编译中断。
 *
 *   · IfFileExists "...${APP_EXECUTABLE_FILENAME}" ...
 *     → 该符号此刻还不存在，报 warning 6000（unknown variable）。
 *       注意 IfFileExists 虽是运行时指令，但它的**路径参数在编译期解析**，
 *       所以不能指望"运行时才有值"。
 *
 * 可用的符号只有 electron-builder 通过命令行 -D 注入的那些，例如：
 *   PRODUCT_NAME / PRODUCT_FILENAME / APP_FILENAME / VERSION /
 *   UNINSTALL_APP_KEY / BUILD_RESOURCES_DIR ...
 * 这些在拼装脚本之前就已定义，任何位置都能用。
 *
 * 结论：判断主程序是否存在，一律用 `"${PRODUCT_FILENAME}.exe"`，
 * 与 common.nsh 里 `!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"`
 * 的结论完全一致，但不受展开顺序影响。
 * ============================================================================
 */

/*
 * 变量与函数都只属于安装器；卸载器编译时整体跳过。
 *
 * 不跳过会连吃两个警告（都实测踩过）：
 *   · 只跳过函数、变量留在外面 → warning 6001
 *     "Variable RdInstalled not referenced or never set"（声明了却没人用）
 *   · 两者都不跳过 → warning 6010
 *     "function DetectInstalled not referenced"（定义了却没人调）
 * electron-builder 把警告当错误，任何一条都会让打包失败。
 *
 * 变量声明必须在所有 Section / Function 之前 —— 所以 !ifndef 要包住整段。
 */
!ifndef BUILD_UNINSTALLER

Var RdInstalled        ; 1 = 已安装（升级），0 = 全新安装
Var RdOldVersion       ; 旧版本号（拿不到时为空）
Var RdOldDir           ; 旧安装目录
Var RdProbe            ; 临时探测器（避免占用 $0~$9 寄存器）

; ---------------------------------------------------------------------------
; 读取已安装信息
;
; 出参：
;   $RdInstalled  1 / 0
;   $RdOldVersion 旧版本（可能为空）
;   $RdOldDir     旧安装目录（可能为空）
;
; 注册表查找顺序有讲究：
;   perMachine=false 的安装写在 HKCU，但用户可能用管理员身份装过（写 HKLM），
;   两者都要查。先查 HKCU —— 同一版本时它更贴近"当前用户实际在用的那份"。
; ---------------------------------------------------------------------------
Function DetectInstalled
  StrCpy $RdInstalled 0
  StrCpy $RdOldVersion ""
  StrCpy $RdOldDir ""

  ; ---- 1) 用户级卸载信息（本安装包的默认写入位置）----
  ;
  ; 注意：InstallLocation **经常是空的**。
  ; electron-builder 默认只写 DisplayName/DisplayVersion/UninstallString/DisplayIcon，
  ; 并不保证写 InstallLocation —— 实测本机 0.0.3 安装后该值就是空字符串。
  ; 只读它会导致"明明装了却检测不到"，永远走全新安装。
  ; 所以下面还会从 UninstallString / DisplayIcon 反推目录。
  ReadRegStr $RdOldDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
  ReadRegStr $RdOldVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"

  ; ---- 1b) InstallLocation 为空时，从 UninstallString 反推 ----
  ;
  ; 形如： "D:\Program Files\RedisDocter\Uninstall RedisDocter.exe" /currentuser
  ; 去掉首尾引号与末尾参数，再剥掉最后的 \文件名，剩下的就是安装目录。
  ${If} $RdOldDir == ""
    ReadRegStr $RdProbe HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
    ${If} $RdProbe != ""
      Call RdDirFromPath
      StrCpy $RdOldDir $RdProbe
    ${EndIf}
  ${EndIf}

  ; ---- 1c) 仍为空，用 DisplayIcon 反推（它指向 $INSTDIR\xxx.ico）----
  ${If} $RdOldDir == ""
    ReadRegStr $RdProbe HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayIcon"
    ${If} $RdProbe != ""
      Call RdDirFromPath
      StrCpy $RdOldDir $RdProbe
    ${EndIf}
  ${EndIf}

  ; ---- 2) 机器级（曾以管理员身份安装过）----
  ${If} $RdOldDir == ""
    ReadRegStr $RdOldDir HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "InstallLocation"
    ReadRegStr $RdOldVersion HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"

    ${If} $RdOldDir == ""
      ReadRegStr $RdProbe HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
      ${If} $RdProbe != ""
        Call RdDirFromPath
        StrCpy $RdOldDir $RdProbe
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; ---- 3) 注册表没查到，看默认安装目录（兜底）----
  ;
  ; 两处细节都是打包实测踩出来的，改动前请先看这里：
  ;
  ; ① 用 ${PRODUCT_FILENAME}.exe，**不要用 ${APP_EXECUTABLE_FILENAME}**。
  ;    后者由 common.nsh 定义，而本文件比 common.nsh 更早展开，
  ;    此时该符号尚未存在，makensis 报:
  ;      warning 6000: unknown variable/constant "{APP_EXECUTABLE_FILENAME}"
  ;    ${PRODUCT_FILENAME} 是 electron-builder 通过命令行 -D 注入的，
  ;    在我这个展开阶段就已可用，拼上 .exe 与 common.nsh 的结论一致。
  ;
  ; ② 用运行时的 IfFileExists，**不要用 ${FileExists}**。
  ;    ${FileExists} 是 LogicLib 的编译期宏，参数在展开时就要能解析。
  ${If} $RdOldDir == ""
    /*
     * 用 $RdProbe 而不是 $0：NSIS 的 $0~$9 是各段共享的寄存器，
     * customInit 里 ReadSystemBitness 刚把系统位数放进 $0，
     * 这里覆盖它会让后续判断读到脏值。自定义 Var 更安全。
     */
    StrCpy $RdProbe "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    IfFileExists "$RdProbe\${PRODUCT_FILENAME}.exe" 0 rd_detect_fallback_done
      StrCpy $RdOldDir "$RdProbe"
  ${EndIf}
  rd_detect_fallback_done:

  ; ---- 判定：目录有效且里面确实有主程序，才算"已安装"----
  ;
  ; 不能只看注册表有键就认定已安装：用户可能只删了程序文件、
  ; 或上次安装中途失败留下空壳。目录 + 可执行文件双重确认才可靠，
  ; 否则会把"全新安装"误判成升级，锁定一个不存在的路径。
  ${If} $RdOldDir != ""
    IfFileExists "$RdOldDir\${PRODUCT_FILENAME}.exe" 0 rd_detect_not_installed
      StrCpy $RdInstalled 1
      Goto rd_detect_end
    rd_detect_not_installed:
      StrCpy $RdOldDir ""
      StrCpy $RdOldVersion ""
  ${EndIf}
  rd_detect_end:
FunctionEnd

; ---------------------------------------------------------------------------
; 从「可执行文件路径」反推出它所在的目录
;
; 入参/出参：$RdProbe（原地改写为目录；无法解析时置空）
;
; 处理的输入形如：
;   "D:\Program Files\RedisDocter\Uninstall RedisDocter.exe" /currentuser
;   "D:\Program Files\RedisDocter\uninstallerIcon.ico"
;   D:\Program Files\RedisDocter\RedisDocter.exe        （无引号）
;
; 步骤：去首尾引号 → 截掉第一个空格后的参数 → 去掉最后一个反斜杠及之后的部分。
;
; 为什么不用 ${GetParent}（FileFunc.nsh）：
;   它同样要求参数在编译期就是常量，而这里是运行时读出来的注册表值。
; 因此手写字符串处理，每一步都可验证。
; ---------------------------------------------------------------------------
Function RdDirFromPath
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  StrLen $4 $RdProbe
  ${If} $4 > 0
    /* ---- ① 去掉首引号 ---- */
    StrCpy $0 $RdProbe 1
    ${If} $0 == '"'
      StrCpy $RdProbe $RdProbe "" 1
      StrLen $4 $RdProbe

      /* 形式： "path" args  —— 逐字符找配对的尾引号 */
      StrCpy $2 0
      rd_q_loop:
        StrCpy $3 $RdProbe 1 $2
        ${If} $3 == ""
          Goto rd_q_done
        ${EndIf}
        ${If} $3 == '"'
          StrCpy $RdProbe $RdProbe $2
          Goto rd_q_done
        ${EndIf}
        IntOp $2 $2 + 1
        Goto rd_q_loop
      rd_q_done:
    ${Else}
      /* 形式： D:/dir with space\app.exe /args —— 只在空格后紧跟 / 或 - 时截断 */
      StrCpy $2 0
      rd_s_loop:
        StrCpy $3 $RdProbe 1 $2
        ${If} $3 == ""
          Goto rd_s_done
        ${EndIf}
        ${If} $3 == " "
          IntOp $5 $2 + 1
          StrCpy $0 $RdProbe 1 $5
          ${If} $0 == "/"
            StrCpy $RdProbe $RdProbe $2
            Goto rd_s_done
          ${EndIf}
          ${If} $0 == "-"
            StrCpy $RdProbe $RdProbe $2
            Goto rd_s_done
          ${EndIf}
        ${EndIf}
        IntOp $2 $2 + 1
        Goto rd_s_loop
      rd_s_done:
    ${EndIf}

    /* ---- ② 从末尾往前找第一个反斜杠，截断到它之前 ---- */
    StrLen $4 $RdProbe
    IntOp $2 $4 - 1
    rd_b_loop:
      ${If} $2 < 0
        StrCpy $RdProbe ""
        Goto rd_b_loop_end
      ${EndIf}
      StrCpy $3 $RdProbe 1 $2
      ${If} $3 == "\"
        StrCpy $RdProbe $RdProbe $2
        Goto rd_b_loop_end
      ${EndIf}
      IntOp $2 $2 - 1
      Goto rd_b_loop
    rd_b_loop_end:
  ${EndIf}

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

; ---------------------------------------------------------------------------
; 升级模式下的目录锁定
;
; 升级必须装回原目录。否则旧版本留在原处、新版本装到别处，
; 快捷方式指向新目录，用户在"程序和功能"里会看到两条记录，
; 卸载其中一条另一条还在 —— 这是覆盖安装最典型的翻车方式。
;
; 补充：electron-builder 对目录页本来就挂了 skipPageIfUpdated，
; 检测到旧版本时**整页跳过**，所以正常情况下用户根本不会看到目录页。
; 这里的赋值仍然必要 —— 它决定了 $INSTDIR 的最终去向：
;   若只依赖跳页，$INSTDIR 会停在默认值（$LOCALAPPDATA\Programs\...），
;   而用户当初可能装在了 D 盘，结果就是"升级"变成了装到另一个地方。
;
; 必须在 .onInit 阶段赋值：目录页一旦创建，$INSTDIR 就按当时的值渲染了。
; ---------------------------------------------------------------------------
!macro RdApplyUpgradeDir
  ${If} $RdInstalled == 1
    ${If} $RdOldDir != ""
      StrCpy $INSTDIR "$RdOldDir"
    ${EndIf}
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 升级 / 全新安装提示
;
; 在 .onInit 末段调用（customInit 里）。此时 UAC 已通过、界面尚未显示，
; 用户看到的第一屏就知道自己在做升级还是首次安装 ——
; 而不是等他选完目录、点完安装才从"完成"页猜出来。
;
; 静默安装（/S）一律不弹：无人值守场景弹窗会卡死流程。
; ---------------------------------------------------------------------------
!macro RdShowInstallNotice
  ${If} ${Silent}
    ; 静默模式：不弹窗，按检测结果直接继续
  ${ElseIf} $RdInstalled == 1
    ${If} $RdOldVersion == ""
      MessageBox MB_OK|MB_ICONINFORMATION \
        "检测到本机已安装 RedisDocter。$\r$\n$\r$\n将执行升级安装：$\r$\n  · 安装目录：$RdOldDir$\r$\n  · 覆盖旧版本程序文件$\r$\n  · 保留现有连接配置与设置"
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION \
        "检测到本机已安装 RedisDocter $RdOldVersion。$\r$\n$\r$\n将升级至 ${VERSION}：$\r$\n  · 安装目录：$RdOldDir$\r$\n  · 覆盖旧版本程序文件$\r$\n  · 保留现有连接配置与设置"
    ${EndIf}
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION \
      "未检测到已安装的 RedisDocter。$\r$\n$\r$\n将执行全新安装，可以自行选择安装目录。"
  ${EndIf}
!macroend
