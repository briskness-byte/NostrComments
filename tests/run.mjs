// NostrComments test runner — dependency-free, run with:  node tests/run.mjs
// Tests extract and exercise the real code from the shipped source files.
import { run as secp } from './secp.test.mjs';
import { run as encrypt } from './encrypt.test.mjs';
import { run as normalize } from './normalize.test.mjs';
import { run as parity } from './parity.test.mjs';
import { run as zap } from './zap.test.mjs';
import { run as bech32 } from './bech32.test.mjs';
import { run as deletion } from './deletion.test.mjs';
import { run as keyimport } from './import.test.mjs';
import { run as popup } from './popup.test.mjs';
import { run as relaymigration } from './relaymigration.test.mjs';

const suites = [await secp(), await encrypt(), await normalize(), await zap(), await bech32(), await deletion(), await keyimport(), await popup(), await relaymigration(), await parity()];

let totalFail = 0;
console.log('');
for (const s of suites) {
    console.log(`${s.fail ? '✗' : '✓'} ${s.name}: ${s.pass} passed, ${s.fail} failed`);
    totalFail += s.fail;
}
console.log(totalFail ? `\n✗ ${totalFail} test(s) FAILED` : '\n✓ all tests passed');
process.exit(totalFail ? 1 : 0);
