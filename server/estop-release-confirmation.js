import crypto from 'node:crypto';

export const ESTOP_RELEASE_DELAY_MS = 10_000;
export const ESTOP_RELEASE_TOKEN_TTL_MS = 60_000;

function clean(value) {
  return String(value ?? '').trim();
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ''), 'utf8');
  const right = Buffer.from(String(rightValue ?? ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(secret, issuedAt, nonce) {
  const payload = String(issuedAt) + '.' + nonce;
  return crypto.createHmac('sha256', secret)
    .update('dealdost-estop-release:v1:' + payload, 'utf8')
    .digest('base64url');
}

/**
 * Issue a short-lived, server-signed challenge. The timestamp is signed so a
 * browser cannot shorten the required delay by editing its local countdown.
 */
export function createEmergencyStopReleaseChallenge(secret, {
  now = Date.now,
  randomBytes = crypto.randomBytes
} = {}) {
  const signingSecret = clean(secret);
  if (!signingSecret) throw new Error('ENGINE_SECRET is not configured');
  if (typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('now and randomBytes must be functions');
  }

  const issuedAt = Number(now());
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
    throw new RangeError('Challenge clock must return a positive safe integer timestamp');
  }

  const nonce = randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Challenge nonce generation failed');
  const token = String(issuedAt) + '.' + nonce + '.' + sign(signingSecret, issuedAt, nonce);

  return Object.freeze({
    token,
    issuedAt,
    availableAt: issuedAt + ESTOP_RELEASE_DELAY_MS,
    expiresAt: issuedAt + ESTOP_RELEASE_TOKEN_TTL_MS
  });
}

/**
 * Verify that the challenge is authentic, old enough, and still short-lived.
 * The API endpoint must also require the explicit checkbox confirmation.
 */
export function verifyEmergencyStopReleaseChallenge(tokenValue, secret, {
  now = Date.now
} = {}) {
  const signingSecret = clean(secret);
  if (!signingSecret || typeof now !== 'function') {
    return { valid: false, reason: 'configuration' };
  }

  const match = clean(tokenValue).match(/^(\d{13})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { valid: false, reason: 'malformed' };

  const issuedAt = Number(match[1]);
  const nonce = match[2];
  const suppliedSignature = match[3];
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 ||
      !safeEqual(suppliedSignature, sign(signingSecret, issuedAt, nonce))) {
    return { valid: false, reason: 'signature' };
  }

  const currentTime = Number(now());
  if (!Number.isSafeInteger(currentTime) || currentTime <= 0) {
    return { valid: false, reason: 'configuration' };
  }

  const ageMs = currentTime - issuedAt;
  if (ageMs < ESTOP_RELEASE_DELAY_MS) {
    return {
      valid: false,
      reason: 'countdown',
      issuedAt,
      availableAt: issuedAt + ESTOP_RELEASE_DELAY_MS,
      expiresAt: issuedAt + ESTOP_RELEASE_TOKEN_TTL_MS
    };
  }
  if (ageMs > ESTOP_RELEASE_TOKEN_TTL_MS) {
    return {
      valid: false,
      reason: 'expired',
      issuedAt,
      availableAt: issuedAt + ESTOP_RELEASE_DELAY_MS,
      expiresAt: issuedAt + ESTOP_RELEASE_TOKEN_TTL_MS
    };
  }

  return {
    valid: true,
    reason: null,
    issuedAt,
    availableAt: issuedAt + ESTOP_RELEASE_DELAY_MS,
    expiresAt: issuedAt + ESTOP_RELEASE_TOKEN_TTL_MS
  };
}
