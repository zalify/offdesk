; Hooks for Tauri's NSIS installer (tauri.conf.json bundle.windows.nsis.installerHooks).
;
; The app was "Offdesk" up to 0.7.11 and is "Offdesk DEV" from 0.7.12 on.
; Tauri's installer keys an install on the product name (its Add/Remove
; Programs entry, install folder and shortcuts), so without this the new
; installer would not see the old install and would put a second copy beside
; it. Before installing, remove the old one the way its own uninstaller does,
; silently. A silent uninstall never deletes app data, and the data lives
; under the identifier (dev.offdesk.desktop), which did not change.
;
; Only an install of this app is touched: its entry names this app's binary.
; Tauri installs per user by default (HKCU); that is the entry checked.

!define OFFDESK_OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Offdesk"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R8 HKCU "${OFFDESK_OLD_UNINSTKEY}" "MainBinaryName"
  ${If} $R8 == "${MAINBINARYNAME}.exe"
    ReadRegStr $R9 HKCU "${OFFDESK_OLD_UNINSTKEY}" "UninstallString"
    ReadRegStr $R7 HKCU "${OFFDESK_OLD_UNINSTKEY}" "InstallLocation"
    ; InstallLocation is written quoted; `_?=` takes the bare folder.
    StrCpy $R6 $R7 1
    ${If} $R6 == '"'
      StrCpy $R7 $R7 -1 1
    ${EndIf}
    ${If} $R9 != ""
    ${AndIf} $R7 != ""
      DetailPrint "Removing the previous install, Offdesk (now Offdesk DEV)"
      ; `_?=` runs the uninstaller in place and waits for it, like Tauri's
      ; own upgrade path. Without /UPDATE it also removes the old shortcuts.
      ExecWait '$R9 /S _?=$R7' $R6
      ; Running in place, the uninstaller can't delete itself.
      Delete "$R7\uninstall.exe"
      RMDir "$R7"
    ${EndIf}
  ${EndIf}
!macroend
