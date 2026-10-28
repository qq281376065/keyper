; ============================================================================
; RedisDocter — 用户配置的保留与清理
; ============================================================================
; 背景：
;   配置文件（connections.json / settings.json / logs）默认放在
;   <安装目录>\config（便携模式，见 electron/services/config-path.ts）。
;   而 electron-builder 卸载模板 uninstaller.nsh 会无条件 RMDir /r $INSTDIR
;   —— 升级时它还要先静默运行一次旧卸载器（installUtil.nsh 的
;   uninstallOldVersion，installSection.nsh:52，先于 customInstall）。
;   于是「升级 = 连 config 一起删」，用户每次升级都要二次配置。
;
;   目标行为：
;     · 升级 / 覆盖安装：配置原样保留（无论机器上装的是哪个旧版本）
;     · 手动交互卸载：询问是否清理配置，默认保留
;     · 静默卸载（/S，含升级时被静默调用的场景）：一律保留
;     · 卸载选择保留时：配置挪到 <安装目录父>\RedisDocter-config，
;       之后重装回同一目录会自动接回，继续免配置
;
;   两套机制，缺一不可：
;     A. 卸载器 customRemoveFiles（对本版本及之后的卸载器生效）：
;        uninstaller.nsh:145 —— 一旦定义了 customRemoveFiles，模板的
;        默认删除段（atomicRMDir + RMDir /r $INSTDIR）整段被替换，
;        删除动作完全由本宏接管：先把 config 挪出安装目录，
;        删完程序文件后再按用户选择恢复或清理。
;     B. 安装器备份 / 恢复（对旧版本的卸载器也生效）：
;        已装 0.0.3~0.0.6 的机器升级时，跑的仍是旧卸载器（没有 A），
;        config 照删不误 —— 所以 customInit 先把 config 复制一份到
;        $APPDATA，customInstall 再合并回去。
; ============================================================================

!include "LogicLib.nsh"

; ---------------------------------------------------------------------------
; 【安装器侧】升级前备份 / 安装后恢复
;
; 安装器趟才编译（卸载器趟没有 $RdInstalled / customInit / customInstall，
; 展开不了也用不上；不隔离会在卸载器趟吃 warning 6001）。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER

Var RdConfigBackup

;
; 在 customInit 中、RdApplyUpgradeDir 之后调用（$INSTDIR 已锁定为旧目录）。
;
; 备份位置选 $APPDATA 而不是安装目录旁：CopyFiles 是复制不是移动，
; 不受跨盘限制；升级中途断电/取消也不会在安装盘留下半成品目录。
;
!macro RdBackupConfig
  StrCpy $RdConfigBackup ""
  ${If} $RdInstalled == 1
    IfFileExists "$INSTDIR\config\*.*" 0 rd_backup_done
      StrCpy $RdConfigBackup "$APPDATA\${APP_FILENAME}\upgrade-config"
      ; 上一轮升级中断可能留下残缺备份，先清再备，避免新旧混装
      RMDir /r "$RdConfigBackup"
      CreateDirectory "$APPDATA\${APP_FILENAME}"
      CreateDirectory "$RdConfigBackup"
      CopyFiles /SILENT "$INSTDIR\config\*.*" "$RdConfigBackup"
    rd_backup_done:
  ${EndIf}
!macroend

;
; 在 customInstall 中调用（此时程序文件已就位、旧卸载器已跑完）。
;
; 顺序有讲究：
;   ① 先接回「卸载时选择保留」的配置（Rename 整目录，秒级）；
;   ② 再把升级备份合并进来（CopyFiles 覆盖同名文件，内容本就同源，
;      覆盖无副作用；config 目录若被①接回则只是原地刷新一遍）。
;
!macro RdRestoreConfig
  ; ① 接回 <安装目录父>\RedisDocter-config（仅当安装目录下还没有 config）
  IfFileExists "$INSTDIR\config\*.*" rd_restore_2 rd_restore_1
  rd_restore_1:
    IfFileExists "$INSTDIR\..\RedisDocter-config\*.*" rd_restore_do 0
    ;
    ; 兼容旧名：项目曾叫 RedisDesktop，那一版卸载时保留的是
    ; <父目录>\RedisDesktop-config。改名后必须仍能接回，
    ; 否则老用户升级上来会以为"配置丢了"（其实只是目录名不同）。
    ;
    IfFileExists "$INSTDIR\..\RedisDesktop-config\*.*" rd_restore_legacy 0
    Goto rd_restore_2

  rd_restore_legacy:
    ; 旧名目录：先改名再按新名接回（保持下面只有一条接回逻辑）
    ClearErrors
    Rename "$INSTDIR\..\RedisDesktop-config" "$INSTDIR\..\RedisDocter-config"
    ${If} ${Errors}
      ; 改不动（被占用）：直接试接回旧名
      CreateDirectory "$INSTDIR"
      ClearErrors
      Rename "$INSTDIR\..\RedisDesktop-config" "$INSTDIR\config"
      ${If} ${Errors}
        ClearErrors
      ${EndIf}
      Goto rd_restore_2
    ${EndIf}

  rd_restore_do:
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$INSTDIR\..\RedisDocter-config" "$INSTDIR\config"
    ${If} ${Errors}
      ; 接不回来（目录被占用等）：留在原地，下次重装还有机会
      ClearErrors
    ${EndIf}
  rd_restore_2:
  ; ② 合并升级期间备份的配置（旧卸载器删掉了 <INSTDIR>\config，这里补回）
  ${If} $RdConfigBackup != ""
    IfFileExists "$RdConfigBackup\*.*" 0 rd_restore_cleanup
      CreateDirectory "$INSTDIR\config"
      CopyFiles /SILENT "$RdConfigBackup\*.*" "$INSTDIR\config"
    rd_restore_cleanup:
    RMDir /r "$RdConfigBackup"
    StrCpy $RdConfigBackup ""
  ${EndIf}
!macroend

!endif

; ---------------------------------------------------------------------------
; 【卸载器侧】接管「删除已安装文件」
; ---------------------------------------------------------------------------
; Var 只属于卸载器（安装器趟没有引用，不隔离会吃 warning 6001）。
; 宏体里引用这些 Var，宏只在卸载器 Section 中展开，安装器趟不展开即安全。
!ifdef BUILD_UNINSTALLER
Var RdConfigKeep
Var RdDelConfig
!endif

;
; customRemoveFiles：接管 uninstaller.nsh 的默认删除段。
;
; ⚠️ 一旦定义此宏，模板的 atomicRMDir + RMDir /r $INSTDIR 整段被替换，
; 必须由本宏自己完成 RMDir —— 漏写等于「卸载后程序文件全留下」。
;
; 流程：挪出 config →（交互时）询问是否清理 → 删除程序文件 → 处置 config。
;
; ⚠️ 卸载器里的 MessageBox 必须带 /SD：升级流程会以 /S 静默调用卸载器，
; 没有 /SD 的弹窗会把 ExecWait 卡死（installUtil.nsh 的重试循环最多 5 次，
; 每次都在同一个弹窗上挂起）。
;
!macro customRemoveFiles
  StrCpy $RdConfigKeep ""
  StrCpy $RdDelConfig 0

  ; ① 把 config 挪出安装目录（同盘 Rename 是瞬移，不复制数据）
  IfFileExists "$INSTDIR\config\*.*" 0 rd_rm_ask
    ClearErrors
    Rename "$INSTDIR\config" "$INSTDIR\..\RedisDocter-config"
    ${If} ${Errors}
      ClearErrors
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "无法自动保留配置目录（$INSTDIR\config 可能被其他程序占用）。$\r$\n$\r$\n如需保留连接配置与设置，请先手动复制该目录，再继续卸载。" /SD IDOK
      ${EndIf}
    ${Else}
      StrCpy $RdConfigKeep "$INSTDIR\..\RedisDocter-config"
    ${EndIf}
  rd_rm_ask:

  ; ② 交互卸载才询问；静默（升级流程 /S）一律保留
  ${If} $RdConfigKeep != ""
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除配置数据？$\r$\n$\r$\n包含：连接配置、界面设置、操作日志。$\r$\n选择「否」将保留到 $INSTDIR\..\RedisDocter-config，重装时可自动恢复。" /SD IDNO IDYES rd_rm_yes
    Goto rd_rm_do
    rd_rm_yes:
    StrCpy $RdDelConfig 1
    rd_rm_do:
  ${EndIf}

  ; ③ 删除程序文件（customRemoveFiles 已接管默认删除动作）
  RMDir /r "$INSTDIR"

  ; ④ 处置挪出的配置
  ${If} $RdConfigKeep != ""
    ${If} $RdDelConfig == 1
      RMDir /r "$RdConfigKeep"
    ${Else}
      CreateDirectory "$INSTDIR"
      ClearErrors
      Rename "$RdConfigKeep" "$INSTDIR\config"
      ${If} ${Errors}
        ClearErrors
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend