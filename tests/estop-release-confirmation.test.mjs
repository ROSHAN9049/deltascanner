// NOTE: Tests not executed by AI. User runs locally with:
//   node --test tests/estop-release-confirmation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createEmergencyStopReleaseChallenge,
  verifyEmergencyStopReleaseChallenge,
  ESTOP_RELEASE_DELAY_MS,
  ESTOP_RELEASE_TOKEN_TTL_MS
} from '../server/estop-release-confirmation.js';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toggleSource = await readFile(new URL('../api/engine/toggle.js', import.meta.url), 'utf8');
const start = source.indexOf('const estopReleaseCountdown = Math.max(');
const end = source.indexOf('\n  const selected = useMemo', start);
const releaseControls = source.slice(start, end);

test('releasing E-STOP opens a modal and starts a ten-second countdown', () => {
  assert.match(releaseControls, /settings\.emergency_stop === true/);
  assert.match(releaseControls, /setShowEstopReleaseConfirmation\(true\)/);
  assert.match(releaseControls, /JSON\.stringify\(\{ requestEmergencyStopRelease: true \}\)/);
  assert.match(releaseControls, /setEstopReleaseCountdownEndsAt\(availableAt\)/);
  assert.match(releaseControls, /setEstopReleaseToken\(data\.emergencyStopReleaseToken\)/);
  assert.match(releaseControls, /Math\.ceil\(\(estopReleaseCountdownEndsAt - clock\) \/ 1000\)/);
});

test('confirmation requires countdown completion and explicit verification checkbox', () => {
  assert.match(releaseControls, /estopReleaseCountdown > 0 \|\|\s*!estopReleaseVerified/);
  assert.match(source, /I have verified system state/);
  assert.match(source, /disabled=\{busy \|\| estopReleaseCountdown > 0 \|\| !estopReleaseVerified \|\| !estopReleaseToken\}/);
});

test('the API requires a signed server challenge, delay and explicit confirmation', () => {
  assert.match(toggleSource, /body\.requestEmergencyStopRelease === true/);
  assert.match(toggleSource, /createEmergencyStopReleaseChallenge\(CONFIG\.engineSecret\)/);
  assert.match(toggleSource, /verifyEmergencyStopReleaseChallenge\(/);
  assert.match(toggleSource, /body\.emergencyStopReleaseVerified !== true/);
  assert.match(toggleSource, /body\.emergencyStopReleaseToken/);
});

test('server-side challenge cannot be used before ten seconds or after expiry', () => {
  const issuedAt = 1_790_000_000_000;
  const challenge = createEmergencyStopReleaseChallenge('test-secret', {
    now: () => issuedAt,
    randomBytes: size => Buffer.alloc(size, 7)
  });
  assert.equal(ESTOP_RELEASE_DELAY_MS, 10_000);
  assert.equal(ESTOP_RELEASE_TOKEN_TTL_MS, 60_000);
  assert.equal(challenge.availableAt, issuedAt + ESTOP_RELEASE_DELAY_MS);

  const tooEarly = verifyEmergencyStopReleaseChallenge(challenge.token, 'test-secret', {
    now: () => challenge.availableAt - 1
  });
  assert.equal(tooEarly.valid, false);
  assert.equal(tooEarly.reason, 'countdown');

  const ready = verifyEmergencyStopReleaseChallenge(challenge.token, 'test-secret', {
    now: () => challenge.availableAt
  });
  assert.equal(ready.valid, true);

  const expired = verifyEmergencyStopReleaseChallenge(challenge.token, 'test-secret', {
    now: () => challenge.expiresAt + 1
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'expired');
});

test('server-side challenge rejects tampering and a different signing secret', () => {
  const challenge = createEmergencyStopReleaseChallenge('test-secret', {
    now: () => 1_790_000_000_000,
    randomBytes: size => Buffer.alloc(size, 3)
  });
  const tampered = challenge.token.replace(/^[0-9]+/, '1790000000001');
  const invalidSignature = verifyEmergencyStopReleaseChallenge(
    tampered, 'test-secret', { now: () => challenge.availableAt }
  );
  assert.equal(invalidSignature.valid, false);
  assert.equal(invalidSignature.reason, 'signature');

  const wrongSecret = verifyEmergencyStopReleaseChallenge(
    challenge.token, 'another-secret', { now: () => challenge.availableAt }
  );
  assert.equal(wrongSecret.valid, false);
  assert.equal(wrongSecret.reason, 'signature');
});

test('E-STOP release is not sent directly from the header button', () => {
  assert.match(source, /onClick=\{requestEmergencyStopChange\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => mutate\(\{ emergencyStop: !settings\.emergency_stop \}\)\}/);
});

test('cancel keeps E-STOP active and clears transient confirmation state', () => {
  assert.match(releaseControls, /const cancelEmergencyStopRelease = \(\) => \{[\s\S]*?setShowEstopReleaseConfirmation\(false\);[\s\S]*?setEstopReleaseVerified\(false\);[\s\S]*?setEstopReleaseCountdownEndsAt\(0\);/);
  assert.match(source, /Keep E-STOP Active/);
});
