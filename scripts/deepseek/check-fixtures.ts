/**
 * Looks through the DeepSeek fixtures for anything private: cookies, tokens, auth
 * headers, emails, user folders, ids that are not placeholders, and the words given
 * with --deny. In the fixtures folder, a fixture written from a --mock session is a
 * problem too: it would replay as a capture. Run it before every commit that touches
 * the fixtures (npm test runs the same checks, without --deny). See docs/calibration.md.
 *
 *   npx tsx scripts/deepseek/check-fixtures.ts --deny "<your name>,<your email>"
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FIXTURES_DIR, fixtureFiles, mockFixtures, sameFolder, strayFixtureFiles } from '../../src/adapters/deepseek/testing/fixtures.js';
import { checkText } from '../../src/adapters/deepseek/testing/sanitize.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    deny: { type: 'string' },
  },
});
const dir = resolve(values.dir ?? FIXTURES_DIR);
const deny = (values.deny ?? '').split(',').map((word) => word.trim()).filter(Boolean);

const files = fixtureFiles(dir);
const findings = files.flatMap((file) => checkText(basename(file), readFileSync(file, 'utf8'), deny));
const stray = strayFixtureFiles(dir);
const mocks = mockFixtures(dir);
const committed = sameFolder(dir, FIXTURES_DIR);
for (const finding of findings) console.log(`${finding.file}:${finding.line} ${finding.rule}: ${finding.excerpt}`);
for (const file of stray) console.log(`${file}: no <name>.json describes it (raw captures never go here)`);
for (const name of mocks) {
  console.log(`${name}.json: written from a --mock session${committed ? ', not a capture: remove it from the fixtures folder' : ' (fine outside the fixtures folder)'}`);
}
const problems = findings.length + stray.length + (committed ? mocks.length : 0);
console.log(`${files.length} file(s) checked in ${dir}: ${problems} problem(s).`);
if (problems > 0) process.exitCode = 1;
