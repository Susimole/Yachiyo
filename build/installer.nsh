; 卸载时清理 —— electron-builder 的自定义 NSIS 片段。
;
; ⚠️⚠️ 为什么需要这一段（2026-10-16 加的）：
;
;     开机自启是往 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 里
;     写一个名叫 `YachiyoPet` 的值（见 `src/core/autostart.cjs` 的 `RUN_NAME`）。
;     卸载程序**不会**碰它 —— `nsis.deleteAppDataOnUninstall` 只管 `%APPDATA%`，
;     跟 HKCU 没关系。
;
;     后果：卸载之后那条注册表还在 → 下次开机 Windows 找不到 exe，
;     弹一个「找不到文件」的错误框，而且他不知道这是哪来的。
;
;     ⚠️ 键名必须跟 autostart.cjs 里的 `RUN_NAME` **一模一样**，改了那边记得改这边。
;
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "YachiyoPet"
!macroend
