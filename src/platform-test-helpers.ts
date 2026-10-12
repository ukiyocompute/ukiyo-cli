import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {statSync} from 'node:fs';
import {join} from 'node:path';

const ps = () => join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export function powershell(script: string, path: string) {
  script="$env:PSModulePath=Join-Path $PSHOME 'Modules'\n"+script;
  return execFileSync(ps(),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {env:{...process.env,UKIYO_TEST_PATH:path},encoding:'utf8',windowsHide:true,timeout:30_000});
}
export function assertPrivate(path: string, directory = false) {
  if(process.platform!=='win32'){assert.equal(statSync(path).mode&0o777,directory?0o700:0o600);return;}
  // Independent ACL inspection, not the production validator.
  const report=JSON.parse(powershell(`$a=Get-Acl -LiteralPath $env:UKIYO_TEST_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
@{ owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; current=$sid; protected=$a.AreAccessRulesProtected; allowed=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Compress`,path));
  assert.equal(report.owner,report.current);assert.equal(report.protected,true);
  assert.ok(report.allowed.length>0);assert.ok(report.allowed.every((sid:string)=>sid===report.current));
}
export function grantOtherUser(path:string) {
  powershell(`$a=Get-Acl -LiteralPath $env:UKIYO_TEST_PATH
$s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow')))
Set-Acl -LiteralPath $env:UKIYO_TEST_PATH -AclObject $a`,path);
}
