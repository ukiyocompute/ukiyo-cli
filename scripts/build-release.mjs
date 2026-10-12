// Builds the single-file release (dist/release/ukiyo-cli-<version>.mjs) and the pinned
// installers, exactly as published at https://u-kiyo.ai/releases/cli/<version>/.
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(process.argv[2]||'dist/release');
const version=JSON.parse(readFileSync(root+'/package.json')).version;
mkdirSync(output,{recursive:true});
const file=`ukiyo-cli-${version}.mjs`;
await build({absWorkingDir:root,entryPoints:[root+'/src/bin.ts'],outfile:output+'/'+file,bundle:true,platform:'node',format:'esm',target:'node22',legalComments:'eof',
  banner:{js:"#!/usr/bin/env node\nimport { createRequire as __ukiyoCreateRequire } from 'node:module';\nconst require = __ukiyoCreateRequire(import.meta.url);"}});
writeFileSync(output+'/'+file,readFileSync(output+'/'+file,'utf8').replace(/^(#!\/usr\/bin\/env node\n[\s\S]*?)#!\/usr\/bin\/env node\n/,'$1'));
if(process.platform!=='win32')chmodSync(output+'/'+file,0o755);
const hash=createHash('sha256').update(readFileSync(output+'/'+file)).digest('hex');
for (const name of ['install.ps1','install.sh']) writeFileSync(output+'/'+name,readFileSync(root+'/'+name,'utf8').replaceAll('\r\n','\n').replace('__CLI_SHA256__',hash));
writeFileSync(output+'/INSTALL.md',readFileSync(root+'/INSTALL.md','utf8').replaceAll('\r\n','\n'));
console.log(JSON.stringify({version,file,sha256:hash}));
