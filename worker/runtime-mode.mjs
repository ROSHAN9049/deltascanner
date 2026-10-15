export function isGithubActionsPublicScanOnly(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' &&
    String(env.ALLOW_SCAN_ONLY_NO_BRIDGE || '').toLowerCase() === 'true' &&
    String(env.TRADETRON_BRIDGE_ENABLED || '').toLowerCase() === 'false' &&
    String(env.DELTA_ENVIRONMENT || '').toUpperCase() === 'SIGNAL_ONLY';
}
