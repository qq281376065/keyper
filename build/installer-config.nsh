; ============================================================================
; Keyper — 用户配置的保留与清理
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
;     · 手动交互卸载：由卸载选项页询问是否清理配置，默认保留
;     · 静默卸载（/S，含升级时被静默调用的场景）：一律保留
;     · 卸载选择保留时：配置挪到 <安装目录父>\Keyper-config，
;       不再放回安装目录（避免卸载后凭空重建一个只剩 config 的目录）；
;       之后重装回同一目录会自动接回，继续免配置
;
;   两套机制，缺一不可：
;     A. 卸载器 customRemoveFiles（对本版本及之后的卸载器生效）：
;        uninstaller.nsh —— 一旦定义了 customRemoveFiles，模板的
;        默认删除段（atomicRMDir + RMDir /r $INSTDIR）整段被替换，
;        删除动作完全由本宏接管：先把 config 挪出安装目录，
;        删完程序文件后再按 $RdDelConfig 处理。
;     B. 安装器备份 / 恢复（对旧版本的卸载器也生效）：
;        已装旧版本的机器升级时，跑的仍是旧卸载器，config 可能被删 ——
;        所以 customInit 先把 config 复制一份到 $APPDATA，customInstall 再合并回去。
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
  ; ① 接回 <安装目录父>\Keyper-config（仅当安装目录下还没有 config）
  IfFileExists "$INSTDIR\config\*.*" rd_restore_2 rd_restore_1
  rd_restore_1:
    IfFileExists "$INSTDIR\..\Keyper-config\*.*" rd_restore_do 0
    ;
    ; 兼容历史名。改名链共三代：
    ;   RedisDesktop-config（最初）→ RedisDocter-config（1.x）→ Keyper-config（现在）
    ; 每一代都可能留在用户机器上。按新→旧顺序尝试，先改名为新名再走统一接回逻辑，
    ; 否则老用户升级上来会以为"配置丢了"（其实只是目录名不同）。
    ;
    ; 先试上一代 RedisDocter-config
    IfFileExists "$INSTDIR\..\RedisDocter-config\*.*" rd_restore_prev 0
    IfFileExists "$INSTDIR\..\RedisDesktop-config\*.*" rd_restore_legacy 0
    Goto rd_restore_2

  rd_restore_prev:
    ClearErrors
    Rename "$INSTDIR\..\RedisDocter-config" "$INSTDIR\..\Keyper-config"
    ${If} ${Errors}
      CreateDirectory "$INSTDIR"
      ClearErrors
      Rename "$INSTDIR\..\RedisDocter-config" "$INSTDIR\config"
      ${If} ${Errors}
        ClearErrors
      ${EndIf}
      Goto rd_restore_2
    ${EndIf}
    Goto rd_restore_do

  rd_restore_legacy:
    ; 最初的名字：先改名再按新名接回（保持下面只有一条接回逻辑）
    ClearErrors
    Rename "$INSTDIR\..\RedisDesktop-config" "$INSTDIR\..\Keyper-config"
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
    Rename "$INSTDIR\..\Keyper-config" "$INSTDIR\config"
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
Var RdConfigExisted
!endif

;
; customRemoveFiles：接管 uninstaller.nsh 的默认删除段。
;
; ⚠️ 一旦定义此宏，模板的 atomicRMDir + RMDir /r $INSTDIR 整段被替换，
; 必须由本宏自己完成 RMDir —— 漏写等于「卸载后程序文件全留下」。
;
; 流程：挪出 config → 删除程序文件 → 按 $RdDelConfig 处置 config。
; $RdDelConfig 由卸载选项页写入（1=删除，0=保留），静默卸载在
; customUnInit 里固定为 0，因此不会再弹窗询问。
;
; ⚠️ 保留配置时不要再把目录移回 $INSTDIR\config：
;    那会在卸载后重建一个只剩 config 的安装目录，用户在资源管理器里
;    看到"程序没卸干净"。保留位置就是 <安装目录父>\Keyper-config。
;
; ⚠️ 卸载器里的 MessageBox 必须带 /SD：升级流程会以 /S 静默调用卸载器，
; 没有 /SD 的弹窗会把 ExecWait 卡死（installUtil.nsh 的重试循环最多 5 次，
; 每次都在同一个弹窗上挂起）。
;
; ⚠️ 本段跑在「段线程」里，任何窗口操作（SetWindowPos / SetWindowText /
; MoveWindow）都会排队到整段结束才被 UI 线程处理 —— 实测宏本身 0.56s 就跑完，
; 界面却到 4.4s 才变。所以卸载进度页的尺寸只能在 UI 线程（选项页 LEAVE）处理，
; 见 installer-resize.nsh 的 RdShrinkDialog。

!macro customRemoveFiles
  StrCpy $RdConfigKeep ""
  StrCpy $RdConfigExisted 0

  ; ① 把 config 挪出安装目录（同盘 Rename 是瞬移，不复制数据）
  IfFileExists "$INSTDIR\config\*.*" 0 rd_rm_files
    StrCpy $RdConfigExisted 1

    ; 目标已存在：上一次卸载保留的目录还在（例如重装到了同一父目录的
    ; 另一个子目录）。直接 Rename 会失败，随后 RMDir 会把配置一并删掉；
    ; 这里改成覆盖写入同一个保留目录，重装时仍能自动接回。
    IfFileExists "$INSTDIR\..\Keyper-config\*.*" 0 rd_rm_rename
      ClearErrors
      CopyFiles /SILENT "$INSTDIR\config\*.*" "$INSTDIR\..\Keyper-config"
      ${If} ${Errors}
        ClearErrors
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "无法把配置写入已有的保留目录（$INSTDIR\..\Keyper-config）。$\r$\n$\r$\n如需保留连接配置与设置，请先手动复制 $INSTDIR\config，再继续卸载。" /SD IDOK
        ${EndIf}
      ${Else}
        StrCpy $RdConfigKeep "$INSTDIR\..\Keyper-config"
      ${EndIf}
      RMDir /r "$INSTDIR\config"
      Goto rd_rm_files

    rd_rm_rename:
      ClearErrors
      Rename "$INSTDIR\config" "$INSTDIR\..\Keyper-config"
      ${If} ${Errors}
        ClearErrors
        ; Rename 失败（被占用）：退化为复制，尽量保住配置文件
        CreateDirectory "$INSTDIR\..\Keyper-config"
        CopyFiles /SILENT "$INSTDIR\config\*.*" "$INSTDIR\..\Keyper-config"
        ${If} ${Errors}
          ClearErrors
          ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONEXCLAMATION "无法自动保留配置目录（$INSTDIR\config 可能被其他程序占用）。$\r$\n$\r$\n如需保留连接配置与设置，请先手动复制该目录，再继续卸载。" /SD IDOK
          ${EndIf}
        ${Else}
          StrCpy $RdConfigKeep "$INSTDIR\..\Keyper-config"
        ${EndIf}
      ${Else}
        StrCpy $RdConfigKeep "$INSTDIR\..\Keyper-config"
      ${EndIf}
  rd_rm_files:

  ; ② 删除程序文件（customRemoveFiles 已接管默认删除动作）
  ; 必须先离开 $INSTDIR：un.onInit 把 OutPath 设成安装目录，进程的工作目录
  ; 停在里面时 RMDir /r 只能清空却删不掉目录本身（模板默认分支也有这一步）。
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"

  ; ③ 处置挪出的配置：仅当用户在选项页明确选择删除时才清理
  ; 不在这里清空 $RdConfigKeep —— 完成页要靠它区分「已删除」与「未发现配置」
  ${If} $RdConfigKeep != ""
  ${AndIf} $RdDelConfig == 1
    RMDir /r "$RdConfigKeep"
  ${EndIf}
!macroend