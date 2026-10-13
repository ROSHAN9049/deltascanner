import crypto from 'node:crypto';
import { CONFIG } from './config.js';

const MAX_DEPLOYMENT_PAGES = 2;
const MAX_DEPLOYMENTS_PER_SYNC = 8;
const MAX_NOTIFICATIONS_PER_SYNC = 100;

export class TradetronDeveloperApiError extends Error {
  constructor(message, { status = null, code = 'API_ERROR', retryable = false } = {}) {
    super(message);
    this.name = 'TradetronDeveloperApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const finiteNumber = value => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};
const safeIso = value => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  const numeric = Number(text);
  const date = /^\d{10,13}$/.test(text) && Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function redactSensitiveFields(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(secret|token|password|authorization|api.?key|credential)/i.test(key))
    .map(([key, item]) => [key, redactSensitiveFields(item)]));
}

export function buildTradetronPnlHistoryRows(snapshots = [], capturedAt = new Date().toISOString()) {
  const capturedMs = Date.parse(capturedAt);
  if (!Number.isFinite(capturedMs)) return [];
  // Store one observation per 5-minute bucket. Repeated one-minute polling
  // refreshes the same bucket instead of producing an unbounded duplicate log.
  const bucketMs = Math.floor(capturedMs / 300000) * 300000;
  const bucketAt = new Date(bucketMs).toISOString();
  return (Array.isArray(snapshots) ? snapshots : []).flatMap(snapshot => {
    const id = finiteNumber(snapshot?.deployment_id);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    return [{
      snapshot_id: id + ':' + bucketMs,
      deployment_id: id,
      deployment_name: String(snapshot.deployment_name || ('Deployment ' + id)).slice(0, 240),
      captured_at: bucketAt,
      reported_pnl: finiteNumber(snapshot.pnl),
      open_positions: finiteNumber(snapshot.open_positions),
      total_positions: finiteNumber(snapshot.total_positions),
      currency_code: snapshot.currency_code == null ? null : String(snapshot.currency_code).slice(0, 12),
      status: snapshot.status == null ? null : String(snapshot.status).slice(0, 80),
      raw_summary: {
        deployment_id: id,
        deployment_name: String(snapshot.deployment_name || ('Deployment ' + id)).slice(0, 240),
        pnl: finiteNumber(snapshot.pnl),
        open_positions: finiteNumber(snapshot.open_positions),
        total_positions: finiteNumber(snapshot.total_positions),
        currency_code: snapshot.currency_code == null ? null : String(snapshot.currency_code).slice(0, 12),
        status: snapshot.status == null ? null : String(snapshot.status).slice(0, 80),
        as_of: safeIso(snapshot.as_of)
      }
    }];
  });
}

export class TradetronDeveloperApi {
  constructor({
    apiKey = CONFIG.tradetronDeveloperApiKey,
    baseUrl = CONFIG.tradetronDeveloperApiBaseUrl,
    timeoutMs = CONFIG.tradetronDeveloperApiTimeoutMs,
    fetchImpl = globalThis.fetch
  } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.baseUrl = String(baseUrl || 'https://tradetron.tech/api/v1').replace(/\/+$/, '');
    this.timeoutMs = Math.min(15000, Math.max(2000, Number(timeoutMs) || 8000));
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async get(path) {
    if (!this.isConfigured()) {
      throw new TradetronDeveloperApiError('TRADETRON_DEVELOPER_API_KEY is not configured', {
        code: 'NOT_CONFIGURED'
      });
    }
    const requestedPath = String(path);
    const allowedPath = requestedPath === '/me/notifications' ||
      requestedPath === '/me/deployments' ||
      /^\/me\/deployments\?page=\d+$/.test(requestedPath) ||
      /^\/me\/deployments\/\d+\/positions$/.test(requestedPath);
    if (!allowedPath) {
      throw new TradetronDeveloperApiError('Unsupported Tradetron Developer API path', { code: 'INVALID_PATH' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl + path, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + this.apiKey,
          'User-Agent': 'DealDost-DeltaScanner/2.0'
        },
        cache: 'no-store',
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new TradetronDeveloperApiError('Tradetron Developer API returned invalid JSON', {
          status: response.status,
          code: 'INVALID_JSON',
          retryable: response.status >= 500
        });
      }
      if (!response.ok) {
        const status = response.status;
        const reason = status === 401 || status === 403
          ? 'authentication or read permission denied'
          : status === 429 ? 'rate limit exceeded' : 'request failed';
        throw new TradetronDeveloperApiError('Tradetron Developer API ' + reason + ' (HTTP ' + status + ')', {
          status,
          code: 'HTTP_' + status,
          retryable: status === 429 || status >= 500
        });
      }
      if (payload?.success !== true || !payload?.data || typeof payload.data !== 'object') {
        throw new TradetronDeveloperApiError('Tradetron Developer API response did not match the verified success/data envelope', {
          status: response.status,
          code: 'INVALID_RESPONSE'
        });
      }
      return payload.data;
    } catch (error) {
      if (error instanceof TradetronDeveloperApiError) throw error;
      if (error?.name === 'AbortError') {
        throw new TradetronDeveloperApiError('Tradetron Developer API request timed out', {
          code: 'TIMEOUT',
          retryable: true
        });
      }
      throw new TradetronDeveloperApiError('Tradetron Developer API network request failed', {
        code: 'NETWORK_ERROR',
        retryable: true
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async listNotifications() {
    const data = await this.get('/me/notifications');
    const notificationRows = [
      Array.isArray(data) ? data : null,
      Array.isArray(data?.notifications) ? data.notifications : null,
      Array.isArray(data?.items) ? data.items : null,
      Array.isArray(data?.results) ? data.results : null,
      Array.isArray(data?.data) ? data.data : null,
      Array.isArray(data?.data?.notifications) ? data.data.notifications : null,
      Array.isArray(data?.data?.items) ? data.data.items : null,
      Array.isArray(data?.result?.notifications) ? data.result.notifications : null
    ].find(Array.isArray);

    if (!notificationRows) {
      throw new TradetronDeveloperApiError('Notification response did not contain a verified notifications array', {
        code: 'INVALID_NOTIFICATIONS'
      });
    }

    const capturedAt = new Date().toISOString();
    const notifications = notificationRows
      .slice(0, MAX_NOTIFICATIONS_PER_SYNC)
      .filter(row => row && typeof row === 'object' && !Array.isArray(row))
      .map(row => {
        const records = [row, row.notification, row.data].filter(
          value => value && typeof value === 'object' && !Array.isArray(value)
        );
        const pickText = keys => {
          for (const record of records) {
            for (const key of keys) {
              const value = record?.[key];
              if (['string', 'number', 'boolean'].includes(typeof value) && String(value).trim()) {
                return String(value).trim();
              }
            }
          }
          return '';
        };
        const sourceId = pickText([
          'notification_id', 'notificationId', 'event_id', 'eventId', 'id', 'uuid', 'guid'
        ]);
        const notificationId = (sourceId || 'hash-' + crypto.createHash('sha256')
          .update(JSON.stringify(row))
          .digest('hex')).slice(0, 180);
        const eventTimeText = pickText([
          'event_at', 'eventAt', 'created_at', 'createdAt', 'created', 'timestamp', 'time', 'date'
        ]);
        const eventTime = eventTimeText ? safeIso(eventTimeText) : null;
        const deploymentId = pickText([
          'deployment_id', 'deploymentId', 'deployed_strategy_id', 'deployedStrategyId'
        ]);

        return {
          notification_id: notificationId,
          deployment_id: deploymentId || null,
          notification_type: pickText([
            'notification_type', 'notificationType', 'event_type', 'eventType', 'type', 'category', 'action', 'status'
          ]) || null,
          title: pickText(['title', 'subject', 'heading', 'name']) || null,
          description: pickText(['description', 'message', 'body', 'text', 'details', 'notification']) || null,
          event_at: eventTime,
          raw: redactSensitiveFields(row),
          last_seen_at: capturedAt,
          updated_at: capturedAt
        };
      });

    return {
      notifications,
      returnedCount: notificationRows.length,
      storedCount: notifications.length,
      capturedAt
    };
  }

  async listDeployments() {
    const deployments = [];
    let lastPage = 1;
    let truncated = false;
    for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page++) {
      const suffix = page === 1 ? '' : '?page=' + page;
      const data = await this.get('/me/deployments' + suffix);
      if (!Array.isArray(data.deployments)) {
        throw new TradetronDeveloperApiError('Deployment response is missing data.deployments[]', {
          code: 'INVALID_DEPLOYMENTS'
        });
      }
      deployments.push(...data.deployments);
      const reportedLastPage = Math.max(1, Math.floor(finiteNumber(data.last_page) || 1));
      lastPage = Math.max(lastPage, reportedLastPage);
      if (page >= reportedLastPage) break;
      if (page === MAX_DEPLOYMENT_PAGES) truncated = true;
    }
    return { deployments, lastPage, truncated };
  }

  async deploymentPositions(deploymentId) {
    const id = String(deploymentId ?? '').trim();
    if (!/^\d+$/.test(id)) {
      throw new TradetronDeveloperApiError('Deployment ID is invalid', { code: 'INVALID_DEPLOYMENT_ID' });
    }
    const data = await this.get('/me/deployments/' + encodeURIComponent(id) + '/positions');
    if (String(data.deployment_id ?? '') !== id || typeof data.positions_hidden !== 'boolean' || !Array.isArray(data.positions)) {
      throw new TradetronDeveloperApiError('Position response did not match the verified deployment_id / positions_hidden boolean / positions[] shape', {
        code: 'INVALID_POSITIONS'
      });
    }
    return {
      deployment_id: Number(id),
      positions_hidden: data.positions_hidden,
      as_of: safeIso(data.as_of),
      positions: data.positions
    };
  }

  async fetchSnapshot() {
    const listed = await this.listDeployments();
    const allDeployments = listed.deployments;
    const selected = allDeployments.slice(0, MAX_DEPLOYMENTS_PER_SYNC);
    const snapshots = [];
    const failedDeploymentIds = [];
    let totalPositionRows = 0;
    const attemptedAt = new Date().toISOString();

    for (const deployment of selected) {
      const id = finiteNumber(deployment?.deployment_id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        failedDeploymentIds.push('unknown');
        continue;
      }
      try {
        const positions = await this.deploymentPositions(id);
        totalPositionRows += positions.positions.length;
        snapshots.push({
          deployment_id: id,
          deployment_name: String(deployment.name || ('Deployment ' + id)).slice(0, 240),
          deployment_type: deployment.deployment_type == null ? null : String(deployment.deployment_type).slice(0, 80),
          status: deployment.status == null ? null : String(deployment.status).slice(0, 80),
          broker: deployment.broker == null ? null : String(deployment.broker).slice(0, 120),
          multiplier: finiteNumber(deployment.multiplier),
          capital: finiteNumber(deployment.capital),
          pnl: finiteNumber(deployment.pnl),
          open_positions: finiteNumber(deployment.open_positions),
          total_positions: finiteNumber(deployment.total_positions),
          currency_code: deployment.currency_code == null ? null : String(deployment.currency_code).slice(0, 12),
          deployed_on: deployment.deployed_on == null ? null : String(deployment.deployed_on).slice(0, 32),
          positions_hidden: positions.positions_hidden,
          as_of: positions.as_of,
          positions: positions.positions,
          last_success_at: attemptedAt,
          updated_at: attemptedAt
        });
      } catch {
        failedDeploymentIds.push(String(id));
      }
    }

    const truncatedByLimit = allDeployments.length > selected.length;
    const partial = listed.truncated || truncatedByLimit || failedDeploymentIds.length > 0;
    const deploymentIds = allDeployments
      .map(row => finiteNumber(row?.deployment_id))
      .filter(id => Number.isSafeInteger(id) && id > 0);

    const errors = [];
    if (listed.truncated) errors.push('Deployment pagination exceeded the safe two-page limit');
    if (truncatedByLimit) errors.push('Only the first ' + MAX_DEPLOYMENTS_PER_SYNC + ' deployments are synced per cycle');
    if (failedDeploymentIds.length) errors.push('Position fetch failed for deployment IDs: ' + failedDeploymentIds.join(', '));

    return {
      status: partial ? 'PARTIAL' : 'OK',
      attemptedAt,
      lastSuccessAt: partial ? null : attemptedAt,
      deploymentCount: allDeployments.length,
      positionCount: totalPositionRows,
      deploymentIds,
      failedDeploymentIds,
      lastPage: listed.lastPage,
      error: errors.length ? errors.join('; ') : null,
      snapshots
    };
  }
}
