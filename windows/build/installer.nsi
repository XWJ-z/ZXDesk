; ZXDesk Windows 安装包（NSIS 3.08 / MUI2 / Unicode / 简体中文）
;
; 由 `node build/make-setup.js` 调用，下面三个宏必须由 -D 传入：
;   -DAPP_VERSION=0.2.2
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
Var DataSource
Var DataDirHasData
Var DefaultDir
Var LastDataDir
Var ProbeDir
Var HasData
Var DataDirField
Var DataDirBrowse

!insertmacro MUI_PAGE_WELCOME

; 许可协议：必须勾选才能继续（装在欢迎页之后、选路径之前）
; ⚠️ 协议正文由 `build/make-eula.js` 从 `build/eula.txt` 生成 `build/eula.rtf`：
;    RTF 是纯 ASCII（中文用 \uNNNN? 转义），不会因为编码问题在向导里变乱码。
;    `dist:setup` 每次编译前都会重生成，⛔ 不要手改 rtf。
!define MUI_LICENSEPAGE_CHECKBOX
!define MUI_LICENSEPAGE_CHECKBOX_TEXT "我已阅读并同意上述许可协议"
!define MUI_LICENSEPAGE_TEXT_TOP "请阅读以下许可协议。勾选下方选项后才能继续安装。"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "协议全文也会安装到程序目录的 EULA.txt，随时可以查看。"
!insertmacro MUI_PAGE_LICENSE "eula.rtf"

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

; ---------------------------------------------------------------- 数据目录识别
;
; 目标：升级 / 重装时默认值必须是**上次真正在用的那个目录**。
; 写死默认值会让用户装完像「全新的一样」——会话、记住的密码、偏好全不见，
; 其实数据还在旧目录里没动（0.2.2 首次出安装包时踩到，老大 2026-10-27 指出）。
;
; 顺序（先严后宽）：
;   ① 注册表 HKCU\Software\ZXDesk\DataDir（上次安装写的），**且那个目录里确实有数据**
;   ② 上一次安装目录里的 install.ini 的 data=（注册表被清理时还能靠它）
;   ③ 常见位置逐个探：%LOCALAPPDATA%\ZXDesk\data、%LOCALAPPDATA%\ZXDesk、
;      %APPDATA%\ZXDesk\data、%APPDATA%\ZXDesk
;   ④ ①/② 记录的位置还在（只是被清空了）⇒ 仍用它，并写明「当前是空的」
;   ⑤ 都没有 ⇒ 首次安装默认值 %LOCALAPPDATA%\ZXDesk\data
;
; 「有数据」的判据与程序一致（src/main/store/paths.js 的 dataFiles）：
;   prefs.json / session.bin / credential.bin / tofu.json / notices-cache.json /
;   logs\boot.log / profile 子目录 —— 任何一样存在就算用过。
; 试一个候选目录：有数据就定下来（$DataDir 为空才试，先到先得）。
; ⚠️ 宏必须先定义后使用（NSIS 是预处理，不是运行时）。
!macro TryDataCandidate DIR LABEL
  ${If} $DataDir == ""
    StrCpy $ProbeDir "${DIR}"
    Call ProbeDataDir
    ${If} $HasData == 1
      StrCpy $DataDir "${DIR}"
      StrCpy $DataSource "${LABEL}"
      StrCpy $DataDirHasData 1
    ${EndIf}
  ${EndIf}
!macroend

Function DetectDataDir
  StrCpy $DataDir ""
  StrCpy $DataSource ""
  StrCpy $DataDirHasData 0
  StrCpy $DefaultDir "$LOCALAPPDATA\ZXDesk\data"

  ; ① 注册表里上次安装选的位置
  ClearErrors
  ReadRegStr $LastDataDir HKCU "${APP_KEY}" "DataDir"
  ${If} ${Errors}
    StrCpy $LastDataDir ""
  ${EndIf}
  ${If} $LastDataDir != ""
    StrCpy $ProbeDir "$LastDataDir"
    Call ProbeDataDir
    ${If} $HasData == 1
      StrCpy $DataDir "$LastDataDir"
      StrCpy $DataSource "上次安装时选的位置"
      StrCpy $DataDirHasData 1
    ${EndIf}
  ${EndIf}

  ; ② 上一个版本的 install.ini（注册表丢了的兜底）
  ${If} $DataDir == ""
    StrCpy $0 ""
    ReadRegStr $0 HKCU "${APP_KEY}" "InstallDir"
    ${If} $0 != ""
      StrCpy $1 ""
      ReadINIStr $1 "$0\install.ini" "install" "data"
      ${If} $1 != ""
        StrCpy $ProbeDir "$1"
        Call ProbeDataDir
        ${If} $HasData == 1
          StrCpy $DataDir "$1"
          StrCpy $DataSource "上一个版本的 install.ini"
          StrCpy $DataDirHasData 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; ③ 常见位置：谁有数据用谁
  !insertmacro TryDataCandidate "$LOCALAPPDATA\ZXDesk\data" "本机已有的数据（安装版默认位置）"
  !insertmacro TryDataCandidate "$LOCALAPPDATA\ZXDesk" "本机已有的数据（旧版兜底位置）"
  !insertmacro TryDataCandidate "$APPDATA\ZXDesk\data" "本机已有的数据（漫游目录）"
  !insertmacro TryDataCandidate "$APPDATA\ZXDesk" "本机已有的数据（漫游目录）"

  ; ④ 记录过的位置还在（空目录）⇒ 仍用它，别把用户甩到另一个空目录
  ${If} $DataDir == ""
  ${AndIf} $LastDataDir != ""
    StrCpy $DataDir "$LastDataDir"
    StrCpy $DataSource "上次安装时选的位置"
  ${EndIf}

  ; ⑤ 首次安装
  ${If} $DataDir == ""
    StrCpy $DataDir "$DefaultDir"
    StrCpy $DataSource "首次安装的默认位置"
  ${EndIf}
FunctionEnd

; 输入 $ProbeDir；输出 $HasData（1 = 这里有 ZXDesk 的数据）。
; ⚠️ 标签在 NSIS 里是全局的，名字不要再出现在别的函数里。
Function ProbeDataDir
  StrCpy $HasData 0
  IfFileExists "$ProbeDir\prefs.json" 0 zxdProbeSession
    StrCpy $HasData 1
    Return
  zxdProbeSession:
  IfFileExists "$ProbeDir\session.bin" 0 zxdProbeCred
    StrCpy $HasData 1
    Return
  zxdProbeCred:
  IfFileExists "$ProbeDir\credential.bin" 0 zxdProbeTofu
    StrCpy $HasData 1
    Return
  zxdProbeTofu:
  IfFileExists "$ProbeDir\tofu.json" 0 zxdProbeNotices
    StrCpy $HasData 1
    Return
  zxdProbeNotices:
  IfFileExists "$ProbeDir\notices-cache.json" 0 zxdProbeLog
    StrCpy $HasData 1
    Return
  zxdProbeLog:
  IfFileExists "$ProbeDir\logs\boot.log" 0 zxdProbeProfile
    StrCpy $HasData 1
    Return
  zxdProbeProfile:
  IfFileExists "$ProbeDir\profile\*.*" 0 zxdProbeDone
    StrCpy $HasData 1
    Return
  zxdProbeDone:
FunctionEnd

Function .onInit
  Call DetectDataDir
FunctionEnd

Function DataPageCreate
  !insertmacro MUI_HEADER_TEXT "选择数据路径" "偏好、会话、记住的密码、日志都放这里。可以放到别的盘。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "数据不会放进程序目录（Program Files 需要管理员权限才能写）。选一个你方便备份的位置："
  Pop $0

  ${NSD_CreateDirRequest} 0 26u -60u 13u "$DataDir"
  Pop $DataDirField
  ${NSD_OnChange} $DataDirField DataDirChanged

  ${NSD_CreateBrowseButton} -58u 26u 58u 13u "浏览…"
  Pop $DataDirBrowse
  ${NSD_OnClick} $DataDirBrowse DataDirBrowseClick

  ; 默认值是怎么来的、里面有没有东西 —— 用户最关心的就是「装完会不会像新的」
  ${If} $DataDirHasData == 1
    StrCpy $2 "已自动填入：$DataSource。安装后直接接着用（偏好 / 会话 / 记住的密码都还在）。"
  ${ElseIf} $DataSource == "上次安装时选的位置"
    StrCpy $2 "已自动填入上次安装时选的位置（当前是空的）。"
  ${Else}
    StrCpy $2 "没有找到已有数据，这是首次安装的默认位置。"
  ${EndIf}
  ${NSD_CreateLabel} 0 44u 100% 30u "$2"
  Pop $0

  ${NSD_CreateLabel} 0 74u 100% 26u "卸载时默认保留这个目录；安装程序只会把它建出来，不写任何东西。"
  Pop $0

  ; 绿色版的数据在解压目录里，安装程序按注册表 / 常见位置都找不到 —— 直接告诉他去哪找
  ${NSD_CreateLabel} 0 100u 100% 30u "之前用绿色版？数据在解压目录的 data 文件夹里 —— 点「浏览…」指到那里，装完就能接着用。"
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

  ; 去掉结尾的反斜杠（D:\ZXDeskData\ → D:\ZXDeskData）：
  ; 带尾巴会让下面的比较、install.ini 与程序读取都多一个字符。
  ; 盘根（D:\）长度正好 3，不能砍。
  ${Do}
    StrLen $3 $DataDir
    ${If} $3 <= 3
      ${ExitDo}
    ${EndIf}
    StrCpy $2 $DataDir 1 -1
    ${If} $2 != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy $DataDir $DataDir -1
  ${Loop}

  ; 数据目录不许落在安装目录里（**任何子目录**都不行）：卸载 / 升级会连数据一起动
  StrLen $3 $INSTDIR
  StrCpy $2 $DataDir $3
  ${If} $2 == "$INSTDIR"
    StrCpy $4 $DataDir 1 $3
    ${If} $4 == ""
    ${OrIf} $4 == "\"
      MessageBox MB_ICONEXCLAMATION "数据目录不能放在安装目录里（$INSTDIR）。$\r$\n$\r$\n换一个位置，例如 D:\ZXDeskData。"
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- 安装前关闭正在运行的程序
;
; 为什么必须关：安装包要覆盖 `$INSTDIR\ZXDesk.exe` 与 `uninst.exe`。进程开着时这两个文件
; 被占用，NSIS 的 File 会失败，安装直接中止 —— 0.2.2 第一次自动更新就是这样被打断的
;（老大 2026-10-27 报：「更新安装没有自动关闭 ZXDesk，导致安装中止」）。
;
; 顺序：先发 WM_CLOSE（等于点窗口 X，给会话 / 偏好落盘的时间）→ 等最多 4 秒 →
;       还在就 /F 强杀（「关闭到托盘」开着时会拦 WM_CLOSE，只能强杀）→ 仍不行让用户手动处理。
;
; ⚠️ 只在 Section 里调用，不放在 .onInit：用户在向导里点「取消」时，不该把正在用的程序关掉。

Function TryCloseApp
  StrCpy $R0 1

  ; ① 优雅关闭：不带 /F 的 taskkill 向窗口发 WM_CLOSE
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "${PRODUCT_EXE}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Return ; 非 0（通常 128）= 没有这个进程，本来就没开
  ${EndIf}

  ; ② 等它自己退（最多 4 秒，10 × 400ms）
  StrCpy $2 0
  ${Do}
    Sleep 400
    nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "${PRODUCT_EXE}"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Return ; 已经退出
    ${EndIf}
    IntOp $2 $2 + 1
    ${If} $2 >= 10
      ${ExitDo}
    ${EndIf}
  ${Loop}

  ; ③ 托盘常驻会拦 WM_CLOSE ⇒ 强杀
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM "${PRODUCT_EXE}"'
  Pop $0
  Pop $1
  Sleep 600
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "${PRODUCT_EXE}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Return ; 已经没了
  ${EndIf}

  StrCpy $R0 0
FunctionEnd

Function CloseRunningApp
  Call TryCloseApp
  ${If} $R0 == 1
    Return
  ${EndIf}

  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "${PRODUCT_NAME} 正在运行，安装程序需要先关闭它。$\r$\n$\r$\n请手动退出（托盘里的图标也要退出），然后点「重试」。" \
    IDRETRY zxdRetryClose
  Abort

  zxdRetryClose:
  Call TryCloseApp
  ${If} $R0 == 0
    MessageBox MB_ICONSTOP \
      "${PRODUCT_NAME} 仍在运行，安装无法继续。$\r$\n$\r$\n请退出后重新运行安装程序。"
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- 组件

Section "ZXDesk 主程序" SecMain
  SectionIn RO

  ; 先关掉正在运行的 ZXDesk，否则下面的 File 覆盖 exe / uninst.exe 会失败（安装中止）
  Call CloseRunningApp

  SetOutPath "$INSTDIR"
  File /r "${SRC_DIR}/*"

  ; 许可协议全文（安装时勾选的就是这份），装到程序目录便于日后查看。
  ; ⚠️ 用 UTF-16LE+BOM 那个副本：记事本对无 BOM 的 UTF-8 会按 ANSI 打开，中文全是乱码。
  File /oname=EULA.txt "eula-utf16.txt"

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
