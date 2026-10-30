import {mkdtempSync,chmodSync,chownSync,writeFileSync,unlinkSync,symlinkSync,rmSync} from 'node:fs'
import {readSystemdDesktopCredential} from './desktop-runtime'
import {test} from 'bun:test'
test.skipIf(process.getuid!() !== 0)('synthetic systemd root-owned credential metadata safety', () => {
const dir=mkdtempSync('/run/credentials/craft-viewer-reader-test-');const path=dir+'/desktop-vnc';process.env.CREDENTIALS_DIRECTORY=dir;let passed=0
function baseline(){try{unlinkSync(path)}catch{}writeFileSync(path,'synthetic',{mode:0o400});chownSync(path,0,0);chmodSync(path,0o440);chmodSync(dir,0o550);chownSync(dir,0,0)}
function deny(change:()=>void){baseline();change();let rejected=false;try{readSystemdDesktopCredential(path)}catch{rejected=true}if(!rejected)throw new Error('Synthetic unsafe credential accepted');passed++}
try{
 baseline();if(readSystemdDesktopCredential(path)!=='synthetic')throw new Error('Compatible read failed');passed++
 deny(()=>chmodSync(path,0o640));deny(()=>chmodSync(path,0o444));deny(()=>chownSync(path,1000,1000));deny(()=>{writeFileSync(path,'x'.repeat(131))});deny(()=>chmodSync(dir,0o750));deny(()=>{unlinkSync(path);symlinkSync('/etc/hostname',path)})
 console.log(`PASS ${passed} synthetic systemd-reader cases (read-onlyACL-mask metadata + unsafe mode/owner/size/directory/symlink rejection); no real credentials read`)
}finally{chmodSync(dir,0o700);rmSync(dir,{recursive:true})}

})
