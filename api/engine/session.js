import { CONFIG } from '../../server/config.js';
import {
  ENGINE_SESSION_TTL_SECONDS,
  clearEngineSessionCookie,
  createEngineSessionCookie,
  isEngineSessionValid,
  isSameOriginRequest,
  safeEngineSecretEqual
} from '../../server/engine-session.js';

function parseBody(req) {
  if (req?.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req?.body !== 'string' || !req.body.trim()) return {};
  try {
    const value = JSON.parse(req.body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('Vary', 'Cookie');

  if (!CONFIG.engineSecret) {
    return res.status(503).json({ success: false, error: 'Server authentication is not configured.' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      configured: true,
      authenticated: isEngineSessionValid(req, CONFIG.engineSecret)
    });
  }

  if (req.method === 'POST') {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ success: false, error: 'A same-origin request is required.' });
    }

    const body = parseBody(req);
    const candidate = typeof body.secret === 'string' ? body.secret : '';
    if (!candidate || candidate.length > 4096 || !safeEngineSecretEqual(candidate, CONFIG.engineSecret)) {
      return res.status(401).json({ success: false, error: 'Invalid ENGINE_SECRET.' });
    }

    res.setHeader('Set-Cookie', createEngineSessionCookie(CONFIG.engineSecret));
    return res.status(200).json({
      success: true,
      authenticated: true,
      expiresInSeconds: ENGINE_SESSION_TTL_SECONDS
    });
  }

  if (req.method === 'DELETE') {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ success: false, error: 'A same-origin request is required.' });
    }
    res.setHeader('Set-Cookie', clearEngineSessionCookie());
    return res.status(200).json({ success: true, authenticated: false });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ success: false, error: 'Method not allowed' });
}
