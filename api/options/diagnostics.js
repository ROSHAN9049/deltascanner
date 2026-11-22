import { CONFIG } from '../../server/config.js';
import { hasValidEngineSecretHeader } from '../../server/engine-session.js';
import { runOptionsDemoCredentialDiagnostic } from '../../worker/options-demo-diagnostics.mjs';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST only' });
  }
  if (!CONFIG.engineSecret || !hasValidEngineSecretHeader(req, CONFIG.engineSecret)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const diagnostic = await runOptionsDemoCredentialDiagnostic({
      env: process.env,
      fetchImpl: (...args) => fetch(...args),
      logger: async () => {}
    });
    if (diagnostic.skipped) {
      return res.status(409).json({ success: false, diagnostic });
    }
    return res.status(diagnostic.signedAuthPassed ? 200 : 409).json({
      success: diagnostic.signedAuthPassed === true,
      diagnostic
    });
  } catch (error) {
    const message = String(error?.message || 'Options Demo API-App diagnostic failed')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 200);
    return res.status(502).json({
      success: false,
      diagnostic: {
        environment: 'DELTA_DEMO_API_APP',
        signedAuthPassed: false,
        signedAuthHttpStatus: null,
        deltaErrorCode: 'diagnostic_failed',
        deltaErrorMessage: message
      }
    });
  }
}
