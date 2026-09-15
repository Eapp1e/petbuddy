# PetBuddy: focus an app's main window and send a SendKeys sequence.
# Exit codes: 0 sent, 2 window not found, 3 process not found, 4 bad usage.
param(
  [Parameter(Mandatory = $true)][string]$Process,
  [Parameter(Mandatory = $true)][string]$Keys,
  [int]$DelayMs = 160,
  [string]$TitleMatch = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace PetBuddy -Name Win32 -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
"@

$procs = Get-Process -Name $Process -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "NOPROCESS"; exit 3 }

$target = $null
if ($TitleMatch -ne '') {
  $target = $procs | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $TitleMatch } | Select-Object -First 1
}
if (-not $target) {
  $target = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if (-not $target) { Write-Output "NOWINDOW"; exit 2 }

$h = $target.MainWindowHandle
if ([PetBuddy.Win32]::IsIconic($h)) { [PetBuddy.Win32]::ShowWindow($h, 9) | Out-Null } # SW_RESTORE
[PetBuddy.Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds $DelayMs

foreach ($k in ($Keys -split '~~')) {
  if ($k -eq '') { continue }
  [System.Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds $DelayMs
}
Write-Output "SENT"
exit 0
