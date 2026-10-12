import { execFile } from 'node:child_process';
import { constants, closeSync, mkdtempSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './output.js';
import {credentialDirectory,isWindows,openPrivateFile,validateStoragePath,windowsAcl} from './storage.js';

export type SshAccess = { host: string; port: number; username: string; privateKey: string };
export async function executeSsh(id: string, access: SshAccess, command: string[], timeout = 60, runner: typeof execFile = execFile): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(access.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(access.username) ||
      !Number.isInteger(access.port) || access.port < 1 || access.port > 65535 || typeof access.privateKey !== 'string' || !access.privateKey.includes('PRIVATE KEY') ||
      !/^[a-zA-Z0-9-]+$/.test(id) || !command.length || command.some(arg => arg.includes('\0')) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Invalid SSH connection, command, or timeout.');
  const directory = credentialDirectory();
  validateStoragePath(directory,true);
  const knownHosts = join(directory, 'known_hosts');
  let fd:number;
  try {fd=openPrivateFile(knownHosts,constants.O_RDWR,true);}catch(error:any){if(error.code!=='EEXIST')throw error;fd=openPrivateFile(knownHosts,constants.O_RDWR);}
  closeSync(fd);
  const temp = mkdtempSync(join(directory, 'ssh-')); const keyFile = join(temp, 'identity');
  try {
    if(isWindows())windowsAcl(temp,'protect');
    validateStoragePath(temp,true);
    const keyFd=openPrivateFile(keyFile,constants.O_WRONLY,true);
    try {writeFileSync(keyFd,access.privateKey);}finally{closeSync(keyFd);}
    const remote = command.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
    const args = ['-F', isWindows()?'NUL':'/dev/null', '-T', '-i', keyFile, '-p', String(access.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new', '-o', `HostKeyAlias=ukiyo-${id}`,
      '-o', `UserKnownHostsFile="${(isWindows()?knownHosts.replaceAll('\\','/'):knownHosts.replaceAll('\\', '\\\\')).replaceAll('"', '\\"')}"`, `${access.username}@${access.host}`, remote];
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH};
    if(isWindows())for(const name of ['SystemRoot','WINDIR','USERPROFILE','LOCALAPPDATA','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
    return await new Promise((resolve, reject) => runner('ssh', args, { timeout: timeout * 1000, maxBuffer: 4 * 1024 * 1024, env, encoding: 'utf8', windowsHide:true }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(new Error(error.killed ? 'SSH command timed out.' : 'SSH transport failed. Check SSH availability and the deployment state.')); return; }
      resolve({ exitCode: error?.code as number ?? 0, stdout: redact(String(stdout), [access.privateKey, process.env.UKIYO_API_TOKEN ?? '']), stderr: redact(String(stderr), [access.privateKey, process.env.UKIYO_API_TOKEN ?? '']) });
    }));
  } finally { try {try{unlinkSync(keyFile);}catch(error:any){if(error.code!=='ENOENT')throw error;}} finally { rmdirSync(temp); } }
}
