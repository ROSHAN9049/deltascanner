import { CONFIG } from './config.js';

const MAX_DEPLOYMENT_PAGES = 2;
const MAX_DEPLOYMENTS_PER_SYNC = 8;

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
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

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
    if (!String(path).startsWith('/me/deployments')) {
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
