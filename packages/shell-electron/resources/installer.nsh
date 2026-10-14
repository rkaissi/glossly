; Uninstall cleanup (decision 71). electron-builder includes this file from build resources.
; Glossly's "Start with Windows" is a Run value for the user; remove it on uninstall, but not
; during an update, which also runs the old uninstaller and would drop the user's choice.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Glossly"
  ${endIf}
!macroend
