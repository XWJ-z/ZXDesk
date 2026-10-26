; ZXDesk Windows 安装包（NSIS 3.08 / MUI2 / Unicode / 简体中文）
;
; 由 `node build/make-setup.js` 调用，下面三个宏必须由 -D 传入：
;   -DAPP_VERSION=0.2.1
;   -DSRC_DIR=<应用目录>          (build/out/ZXDesk-win32-x64)
;   -DOUT_FILE=<输出 setup.exe>
;
; 页序（定的口径）：欢迎 → 安装路径 → 数据路径 → 组件（快捷方式/自启）→ 安装 → 完成
; 规矩：
;   * 安装路径写 Program Files（要管理员）；数据路径默认 %LOCALAPPDATA%\ZXDesk\data，可改到别的盘。
;   * 安装程序只**创建**数据目录，不往里写东西；卸载默认保留数据，勾选才删。
;   * 数据路径写进 `<安装目录>\install.json` 与 HKCU\Software\ZXDesk\DataDir，供应用启动时读取。

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef SRC_DIR
  !error "必须传 -DSRC_DIR=<应用目录>"
!endif
!ifndef OUT_FILE
  !error "必须传 -DOUT_FILE=<输出 setup.exe>"
!endif

!define PRODUCT_NAME "ZXDesk 工作台"
!define PRODUCT_EXE "ZXDesk.exe"
!define COMPANY "ZXDesk"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZXDesk"
!define APP_KEY "Software\ZXDesk"

Name "${PRODUCT_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\ZXDesk"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
RequestExecutionLevel admin
BrandingText "${PRODUCT_NAME} ${APP_VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "${COMPANY}"

; 图标由 make-setup.js 用 -DICON_FILE=<绝对路径> 传进来
!ifdef ICON_FILE
  !define MUI_ICON "${ICON_FILE}"
  !define MUI_UNICON "${ICON_FILE}"
!endif
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${PRODUCT_NAME}"
!define MUI_WELCOMEPAGE_TEXT "本向导会安装 ${PRODUCT_NAME} ${APP_VERSION}。$\r$\n$\r$\n会请你选两个位置：$\r$\n  1. 程序装在哪（安装路径）$\r$\n  2. 你的数据放哪（数据路径：偏好 / 会话 / 凭据 / 日志）$\r$\n$\r$\n数据目录可以放在别的盘，卸载时默认保留。"

Var DataDir
Var DataDirField
Var DataDirBrowse

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom DataPageCreate DataPageLeave
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${PRODUCT_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; ---------------------------------------------------------------- 数据路径页

Function .onInit
  StrCpy $DataDir "$LOCALAPPDATA\ZXDesk\data"
FunctionEnd

Function DataPageCreate
  !insertmacro MUI_HEADER_TEXT "选择数据路径" "偏好、会话、记住的密码、日志都放这里。默认在用户目录，也可以放到别的盘。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "数据不会放进程序目录（Program Files 需要管理员权限才能写）。选一个你方便备份的位置："
  Pop $0

  ${NSD_CreateDirRequest} 0 28u -60u 13u "$DataDir"
  Pop $DataDirField
  ${NSD_OnChange} $DataDirField DataDirChanged

  ${NSD_CreateBrowseButton} -58u 28u 58u 13u "浏览…"
  Pop $DataDirBrowse
  ${NSD_OnClick} $DataDirBrowse DataDirBrowseClick

  ${NSD_CreateLabel} 0 50u 100% 34u "卸载时默认保留这个目录；安装程序现在只会把它建出来，不写任何东西。"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function DataDirChanged
  ${NSD_GetText} $DataDirField $DataDir
FunctionEnd

Function DataDirBrowseClick
  ${NSD_GetText} $DataDirField $DataDir
  nsDialogs::SelectFolderDialog "选择数据目录" "$DataDir"
  Pop $0
  ${If} $0 != error
    StrCpy $DataDir "$0"
    ${NSD_SetText} $DataDirField "$DataDir"
  ${EndIf}
FunctionEnd

Function DataPageLeave
  ${NSD_GetText} $DataDirField $DataDir
  ${If} $DataDir == ""
    MessageBox MB_ICONEXCLAMATION "请选择数据目录（不能为空）。"
    Abort
  ${EndIf}
  ; 数据目录不许落在安装目录里：卸载/升级会连数据一起动
  ${If} $DataDir == "$INSTDIR"
  ${OrIf} $DataDir == "$INSTDIR\data"
    MessageBox MB_ICONEXCLAMATION "数据目录不能和安装目录是同一个（或它的 data 子目录）。请换一个位置。"
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- 组件

Section "ZXDesk 主程序" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}/*"

  ; 安装信息：应用启动时读它决定数据目录。
  ; ⚠️ 用 INI 而不是 JSON：Windows 路径里的反斜杠在 JSON 字符串里必须转义，
  ;    而 NSIS 没有现成的字符串替换 ⇒ 写出来就是坏 JSON。INI 不需要转义。
  WriteINIStr "$INSTDIR\install.ini" "install" "dir" "$INSTDIR"
  WriteINIStr "$INSTDIR\install.ini" "install" "data" "$DataDir"
  WriteINIStr "$INSTDIR\install.ini" "install" "version" "${APP_VERSION}"

  CreateDirectory "$DataDir"

  WriteUninstaller "$INSTDIR\uninst.exe"

  ; 注册表：安装位置（InstallDirRegKey 下次升级默认用上次选的）+ 数据路径 + 卸载项
  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "DataDir" "$DataDir"
  WriteRegStr HKCU "${APP_KEY}" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninst.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "开始菜单快捷方式" SecStartMenu
  CreateDirectory "$SMPROGRAMS\ZXDesk"
  CreateShortCut "$SMPROGRAMS\ZXDesk\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
  CreateShortCut "$SMPROGRAMS\ZXDesk\卸载 ${PRODUCT_NAME}.lnk" "$INSTDIR\uninst.exe"
SectionEnd

Section "桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_EXE}" "" "$INSTDIR\${PRODUCT_EXE}" 0
SectionEnd

Section /o "开机自启" SecAutoStart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZXDesk" '"$INSTDIR\${PRODUCT_EXE}"'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "程序文件（约 250 MB）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} "开始菜单里放一个入口和卸载。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "桌面上放一个快捷方式。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutoStart} "开机自动启动（不需要可在「设置」里关）。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------- 卸载

Function un.onInit
  ReadRegStr $DataDir HKCU "${APP_KEY}" "DataDir"
FunctionEnd

Section "Uninstall"
  ; 先问数据要不要一起删（默认否 —— 数据是用户的东西）
  ${If} $DataDir != ""
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "要同时删除数据目录吗？$\r$\n$\r$\n$DataDir$\r$\n$\r$\n选「否」只卸载程序，数据保留（推荐）。" \
      IDNO keepData
    RMDir /r "$DataDir"
  ${EndIf}
  keepData:

  Delete "$INSTDIR\uninst.exe"
  Delete "$INSTDIR\install.ini"
  RMDir /r "$INSTDIR"

  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\ZXDesk\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\ZXDesk\卸载 ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\ZXDesk"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZXDesk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
SectionEnd
