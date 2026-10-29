// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/estop-release-confirmation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const start = source.indexOf('const estopReleaseCountdown = Math.max(');
const end = source.indexOf('\n  const selected = useMemo', start);
const releaseControls = source.slice(start, end);

test('releasing E-STOP opens a modal and starts a ten-second countdown', () => {
  assert.match(releaseControls, /settings\.emergency_stop === true/);
  assert.match(releaseControls, /setShowEstopReleaseConfirmation\(true\)/);
  assert.match(releaseControls, /setEstopReleaseCountdownEndsAt\(Date\.now\(\) \+ 10_000\)/);
  assert.match(releaseControls, /Math\.ceil\(\(estopReleaseCountdownEndsAt - clock\) \/ 1000\)/);
});

test('confirmation requires countdown completion and explicit verification checkbox', () => {
  assert.match(releaseControls, /estopReleaseCountdown > 0 \|\| !estopReleaseVerified/);
  assert.match(source, /I have verified system state/);
  assert.match(source, /disabled=\{busy \|\| estopReleaseCountdown > 0 \|\| !estopReleaseVerified\}/);
});

test('E-STOP release is not sent directly from the header button', () => {
  assert.match(source, /onClick=\{requestEmergencyStopChange\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => mutate\(\{ emergencyStop: !settings\.emergency_stop \}\)\}/);
});

test('cancel keeps E-STOP active and clears transient confirmation state', () => {
  assert.match(releaseControls, /const cancelEmergencyStopRelease = \(\) => \{[\s\S]*?setShowEstopReleaseConfirmation\(false\);[\s\S]*?setEstopReleaseVerified\(false\);[\s\S]*?setEstopReleaseCountdownEndsAt\(0\);/);
  assert.match(source, /Keep E-STOP Active/);
});
