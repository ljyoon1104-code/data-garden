import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','src/data/examples.test.ts'],{stdio:'inherit',env:{...process.env,GENERATE_EXAMPLES:'1'}});
process.exit(result.status??1);
