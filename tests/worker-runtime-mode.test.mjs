import test from 'node:test';
import assert from 'node:assert/strict';
import { isGithubActionsPublicScanOnly } from '../worker/runtime-mode.mjs';

const safeEnvironment = {
  GITHUB_ACTIONS: 'true',
  ALLOW_SCAN_ONLY_NO_BRIDGE: 'true',
  TRADETRON_BRIDGE_ENABLED: 'false',
  DELTA_ENVIRONMENT: 'SIGNAL_ONLY'
};

test('allows the explicit GitHub Actions public scan-only combination', () => {
  assert.equal(isGithubActionsPublicScanOnly(safeEnvironment), true);
});

test('does not allow no-bridge mode outside GitHub Actions', () => {
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, GITHUB_ACTIONS: 'false' }), false);
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, GITHUB_ACTIONS: undefined }), false);
});

test('does not allow the bypass if the Tradetron bridge is enabled', () => {
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, TRADETRON_BRIDGE_ENABLED: 'true' }), false);
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, TRADETRON_BRIDGE_ENABLED: undefined }), false);
});

test('does not allow the bypass outside SIGNAL_ONLY or without its explicit flag', () => {
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, DELTA_ENVIRONMENT: 'TESTNET' }), false);
  assert.equal(isGithubActionsPublicScanOnly({ ...safeEnvironment, ALLOW_SCAN_ONLY_NO_BRIDGE: 'false' }), false);
});
