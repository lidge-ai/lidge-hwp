import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export async function makeRhwpStub(dir, realBin, { dumpExtra = 1, exportExtra = 1 } = {}) {
  const path = join(dir, `rhwp-stub-${Math.random().toString(36).slice(2)}.mjs`);
  const logFile = `${path}.jsonl`;
  const source = `#!/usr/bin/env node
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const argv=process.argv.slice(2), cmd=argv[0];
const inputSha256=createHash('sha256').update(readFileSync(argv[1])).digest('hex');
appendFileSync(${JSON.stringify(logFile)},JSON.stringify({argv,cmd,inputSha256})+'\\n');
const stdout=execFileSync(${JSON.stringify(realBin)},argv,{encoding:'utf8',maxBuffer:64*1024*1024});
if(cmd==='dump-pages'&&argv.includes('--json')){
  const value=JSON.parse(stdout); value.pageCount+=${dumpExtra}; process.stdout.write(JSON.stringify(value)+'\\n');
}else if(cmd==='export-pdf'&&argv.includes('--json')){
  const value=JSON.parse(stdout); value.pageCount+=${exportExtra};
  if(${exportExtra}>0){const out=argv[argv.indexOf('-o')+1];copyFileSync(out,out+'.extra-page.pdf');}
  process.stdout.write(JSON.stringify(value)+'\\n');
}else process.stdout.write(stdout);
`;
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
  return { path, logFile };
}
