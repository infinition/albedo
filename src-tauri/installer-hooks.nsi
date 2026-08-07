; Shell thumbnail provider.
;
; The DLL registers itself under HKCU, so this needs no elevation and matches an
; installer that runs for the current user. Unregistering happens before the
; files go, otherwise the registry would point at a DLL that no longer exists
; and Explorer would keep asking for it.

!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\albedo_thumbnails.dll"'

  ; A 3D file is not the application, so it does not wear the application's
  ; icon: the cut out mark reads at sixteen pixels and leaves the thumbnail
  ; underneath it visible. Written after the associations so it wins.
  WriteRegStr HKCU "Software\Classes\Modele3D\DefaultIcon" "" "$INSTDIR\albedo-file.ico"
  WriteRegStr HKCU "Software\Classes\ModeleNIF\DefaultIcon" "" "$INSTDIR\albedo-file.ico"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$SYSDIR\regsvr32.exe" /s /u "$INSTDIR\albedo_thumbnails.dll"'
  DeleteRegKey HKCU "Software\Classes\Modele3D\DefaultIcon"
  DeleteRegKey HKCU "Software\Classes\ModeleNIF\DefaultIcon"
!macroend
