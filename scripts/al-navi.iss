; Al-Navi — Inno Setup script (M8, Windows installer).
;
; Per-user install by default: %LOCALAPPDATA%\Programs\Al-Navi, no UAC.
; The user may switch to "all users" in the wizard (then Windows asks for
; elevation — PrivilegesRequiredOverridesAllowed).
;
; Version/stamp are passed from scripts/build-installer.sh:
;   ISCC /DAppVersion=1.2.3 /DStamp=20261004-0655 /O<builddir> al-navi.iss
; Opening this file directly in the Inno editor compiles with the fallback
; defines below.

#ifndef AppVersion
#define AppVersion "0.0.0"
#endif
#ifndef Stamp
#define Stamp "local"
#endif

[Setup]
AppId={{8B1A5C39-6D2E-4F8A-9C4B-7E3A1D5F0B62}
AppName=Al-Navi
AppVersion={#AppVersion}
AppPublisher=Al-Navi
AppPublisherURL=https://github.com/summonss7/Al-Navi
AppUpdatesURL=https://github.com/summonss7/Al-Navi/releases
UninstallDisplayName=Al-Navi {#AppVersion}
UninstallDisplayIcon={app}\Al-Navi.exe
; per-user by default, no admin; "Install for all users" is offered as a choice
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
DefaultDirName={localappdata}\Programs\Al-Navi
DefaultGroupName=Al-Navi
DisableProgramGroupPage=yes
OutputBaseFilename=Al-Navi-Setup-{#AppVersion}-{#Stamp}
SetupIconFile=..\src-tauri\icons\icon.ico
VersionInfoVersion={#AppVersion}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
; the exe is self-contained (static GNU runtime, WebView2 is a system
; component) — nothing else to ship
CloseApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; \
    GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\src-tauri\target\release\al-navi.exe"; DestDir: "{app}"; \
    DestName: "Al-Navi.exe"; Flags: ignoreversion

[Icons]
Name: "{group}\Al-Navi"; Filename: "{app}\Al-Navi.exe"; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallProgram,Al-Navi}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Al-Navi"; Filename: "{app}\Al-Navi.exe"; WorkingDir: "{app}"; \
    Tasks: desktopicon

[Run]
Filename: "{app}\Al-Navi.exe"; WorkingDir: "{app}"; \
    Description: "{cm:LaunchProgram,Al-Navi}"; Flags: nowait postinstall skipifsilent
