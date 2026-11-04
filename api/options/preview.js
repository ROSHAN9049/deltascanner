import { CONFIG } from '../../server/config.js';
import { hasValidEngineSecretHeader, isEngineSessionValid, isSameOriginRequest } from '../../server/engine-session.js';
import { deltaExecutor } from '../../worker/execution/delta-executor.mjs';

function authorized(req) {
  const headerAuthorized = Boolean(CONFIG.engineSecret) &&
    hasValidEngineSecretHeader(req, CONFIG.engineSecret);
  const cookieAuthorized = Boolean(CONFIG.engineSecret) &&
    isEngineSessionValid(req, CONFIG.engineSecret) && isSameOriginRequest(req);
  return Boolean(CONFIG.engineSecret) && (headerAuthorized || cookieAuthorized);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST only' });
  if (!authorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const preview = await deltaExecutor.previewOptionsOrder({
      symbol: body.symbol,
      strategy: body.strategy,
      qty: body.qty ?? 1,
      manualTestOverride: body.manualOverride === true
    });
    return res.status(200).json({ success: true, preview });
  } catch (error) {
    const status = Number(error?.statusCode || error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 409)
      .json({ success: false, error: String(error?.message || 'Options preview failed') });
  }
}
