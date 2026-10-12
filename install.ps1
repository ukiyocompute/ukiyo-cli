# Pinned public CLI installer. This installs no credentials and contacts no rental API.
param([switch]$NoPathUpdate)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$version = '0.2.5'
$expectedHash = '__CLI_SHA256__'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Install Node.js 22 or newer from https://nodejs.org, then rerun this installer.' }
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'Unable to verify Node.js version.' }
if ([int]$Matches[1] -lt 22) { throw 'Node.js 22 or newer is required.' }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'Enable Windows OpenSSH Client in Settings > System > Optional features, then rerun this installer.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required on Windows.' }
$directory = Join-Path $env:LOCALAPPDATA 'Ukiyo\bin'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The installation directory must not be a junction or symlink.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $directory -AclObject $acl
$file = Join-Path $directory "ukiyo-cli-$version.mjs"
$pending = Join-Path $directory ([Guid]::NewGuid().ToString() + '.download')
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing -Uri "https://u-kiyo.ai/releases/cli/$version/ukiyo-cli-$version.mjs" -OutFile $pending
  if ((Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'CLI checksum mismatch. Installation stopped.' }
  Move-Item -LiteralPath $pending -Destination $file -Force
} finally { if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force } }
$wrapper = "@echo off`r`nnode `"%~dp0ukiyo-cli-$version.mjs`" %*`r`nexit /b %errorlevel%`r`n"
[IO.File]::WriteAllText((Join-Path $directory 'ukiyo.cmd'),$wrapper,[Text.Encoding]::ASCII)
if (-not $NoPathUpdate) {
  $userPath = [Environment]::GetEnvironmentVariable('Path','User')
  if (@($userPath -split ';') -notcontains $directory) {
    [Environment]::SetEnvironmentVariable('Path',(($directory + ';' + $userPath).TrimEnd(';')),'User')
  }
}
$env:Path = "$directory;$env:Path"
& (Join-Path $directory 'ukiyo.cmd') --version
if ($LASTEXITCODE -ne 0) { throw 'CLI verification failed.' }
Write-Output 'Installed. Open a new terminal. Before signup, review https://u-kiyo.ai/terms/ and run: ukiyo signup --help'

