import {execFileSync} from 'node:child_process';
import {constants,closeSync,fstatSync,lstatSync,mkdirSync,openSync,type Stats} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const isWindows = () => process.platform === 'win32';
// Node uses USERPROFILE on Windows and HOME on Unix. Preserve existing identities.
export const credentialDirectory = () => join(homedir(), '.ukiyo');

// No secrets are passed to PowerShell: only a literal filesystem path and action.
// SID-based rules work with localized Windows and usernames containing spaces.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$p = $env:UKIYO_STORAGE_PATH
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
if ($env:UKIYO_STORAGE_ACTION -eq 'protect') {
  if ($item.PSIsContainer) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $inherit = [Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
  $acl = Get-Acl -LiteralPath $p
}
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or -not $acl.AreAccessRulesProtected) { throw 'Owner or inheritance' }
$own = $false
foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
  if ($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
    if ($r.IdentityReference.Value -ne $sid.Value) { throw 'Other principal has access' }
    if (($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $own = $true }
  }
}
if (-not $own) { throw 'Missing owner access' }
exit 0
`;

export function windowsAcl(path: string, action: 'protect' | 'validate') {
  try {
    const env: NodeJS.ProcessEnv = {UKIYO_STORAGE_PATH:path,UKIYO_STORAGE_ACTION:action};
    // PowerShell needs its normal module/cache and Windows runtime paths. Omitting
    // these forces expensive module preparation on every security check.
    // Explicitly allow only OS metadata/paths, never API credentials or SSH agents.
    for (const name of ['SystemRoot','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','PATH','TEMP','TMP','PSModulePath','PSModuleAnalysisCachePath','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','ALLUSERSPROFILE','USERDOMAIN','USERNAME','COMPUTERNAME','ComSpec','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','NUMBER_OF_PROCESSORS']) if(process.env[name])env[name]=process.env[name];
    // A parent PowerShell 7 session can advertise incompatible Core modules to
    // Windows PowerShell 5.1. Use only this host's built-in signed modules.
    env.PSModulePath=join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules');
    execFileSync(join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_ACL,'utf16le').toString('base64')],
      {env,stdio:['ignore','pipe','pipe'],timeout:30_000,windowsHide:true});
  } catch (error:any) {
    throw new Error(`Ukiyo storage requires user-only Windows access controls (ACLs), an owned regular path, and Windows PowerShell (${error.code==='ETIMEDOUT'?'access-control check timed out':'access-control check failed'}). No credential was exposed.`);
  }
}

export function validateStorageStat(stat: Stats, dir: boolean) {
  if ((dir ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()) throw new Error('Ukiyo credential storage must be a regular owned path, not a symlink.');
  if (!isWindows() && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
    throw new Error('Ukiyo credential storage must be owned by you, private (0700 directory / 0600 file), and not a symlink.');
}
export function validateStoragePath(path: string, dir: boolean) {
  validateStorageStat(lstatSync(path),dir);
  if (isWindows()) windowsAcl(path,'validate');
}
export function ensureCredentialDirectory() {
  const path=credentialDirectory();
  let created=false;
  try {mkdirSync(path,isWindows()?{}:{mode:0o700});created=true;}catch(error:any){if(error.code!=='EEXIST')throw error;}
  // Never follow an existing directory junction/symlink or silently relax ACLs.
  validateStorageStat(lstatSync(path),true);
  if (isWindows()) windowsAcl(path,created?'protect':'validate');
  return path;
}
export function openPrivateFile(path: string, flags: number, create = false): number {
  const noFollow=isWindows()?0:constants.O_NOFOLLOW;
  let fd: number;
  if (create) fd=openSync(path,flags|constants.O_CREAT|constants.O_EXCL|noFollow,isWindows()?undefined:0o600);
  else {validateStoragePath(path,false);fd=openSync(path,flags|noFollow);}
  try {
    validateStorageStat(fstatSync(fd),false);
    if(isWindows())windowsAcl(path,create?'protect':'validate');
    return fd;
  }catch(error){closeSync(fd);throw error;}
}
