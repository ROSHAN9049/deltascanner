import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const SYMBOLS = Object.freeze(['BTCUSD', 'ETHUSD', 'SOLUSD']);
export const DEFAULT_DURATION_SECONDS = 1800;
export const ORDERBOOK_STALE_AFTER_MS = 15000;
export const TRADE_FLOW_WINDOW_MS = 60000;
const WS_URL = 'wss://public-socket.india.delta.exchange';
const SAMPLE_INTERVAL_MS = 1000;
const IDLE_RECONNECT_AFTER_MS = 45000;
const MAX_RECONNECT_DELAY_MS = 30000;

export function parseDurationArg(argv = []) {
  let raw;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--duration=')) {
      raw = argv[i].slice('--duration='.length);
      break;
    }
    if (argv[i] === '--duration') {
      raw = argv[i + 1];
      break;
    }
  }
  if (raw === undefined) return DEFAULT_DURATION_SECONDS;
  const duration = Number(raw);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86400) {
    throw new Error('Duration must be an integer between 1 and 86400 seconds');
  }
  return duration;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  return levels.map(level => {
    if (Array.isArray(level)) {
      return { price: numeric(level[0]), size: numeric(level[1]) };
    }
    return { price: numeric(level?.price), size: numeric(level?.size) };
  }).filter(level => level.price !== null && level.price > 0
    && level.size !== null && level.size > 0)
    .sort((left, right) => side === 'bid'
      ? right.price - left.price
      : left.price - right.price);
}

export function calculateStaticImbalance(bids, asks, levels = 10) {
  const count = Number.isInteger(levels) && levels > 0 ? levels : 10;
  const topBids = normalizeLevels(bids, 'bid').slice(0, count);
  const topAsks = normalizeLevels(asks, 'ask').slice(0, count);
  const bidVolume = topBids.reduce((total, level) => total + level.size, 0);
  const askVolume = topAsks.reduce((total, level) => total + level.size, 0);
  const totalVolume = bidVolume + askVolume;
  return {
    bidVolume,
    askVolume,
    staticImbalance: totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : null,
    bestBid: topBids.length ? topBids[0].price : null,
    bestAsk: topAsks.length ? topAsks[0].price : null
  };
}

function serverTimestampMs(value) {
  const parsed = numeric(value);
  if (parsed === null || parsed <= 0) return null;
  // Delta timestamps in these channels are Unix microseconds.
  return parsed > 100000000000000 ? Math.round(parsed / 1000) : Math.round(parsed);
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

class OfiCollector {
  constructor(durationSeconds) {
    this.durationSeconds = durationSeconds;
    this.startedAtMs = Date.now();
    this.sessionId = String(this.startedAtMs) + '-' + randomUUID();
    this.filePath = resolve(process.cwd(), 'data', 'ofi-' + new Date(this.startedAtMs).toISOString().slice(0, 10) + '.jsonl');
    this.ws = null;
    this.stopping = false;
    this.stopRequested = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.lastSocketActivityAt = 0;
    this.books = new Map();
    this.trades = new Map(SYMBOLS.map(symbol => [symbol, []]));
    this.sampleRowsWritten = 0;
    this.freshBookSamples = 0;
    this.tradeEventsSeen = 0;
    this.connectionCount = 0;
    this.parseErrors = 0;
    this.maxPositiveImbalanceBySymbol = new Map(SYMBOLS.map(symbol => [symbol, null]));
    this.sampledRowsWithBook = new Map(SYMBOLS.map(symbol => [symbol, 0]));
    this.sampledHighBuyOver030 = new Map(SYMBOLS.map(symbol => [symbol, 0]));
    this.sampledHighBuyOver025 = new Map(SYMBOLS.map(symbol => [symbol, 0]));
    this.signalHandlers = [];
  }

  connect() {
    if (this.stopping || (this.ws && (
      this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING
    ))) return;

    let socket;
    try {
      socket = new WebSocket(WS_URL, { handshakeTimeout: 10000 });
      this.ws = socket;
    } catch (error) {
      console.warn('[OFI] WebSocket creation failed: ' + String(error?.message || error));
      this.scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      if (this.stopping) {
        socket.close(1000, 'collector stopping');
        return;
      }
      this.connectionCount += 1;
      this.reconnectAttempt = 0;
      this.lastSocketActivityAt = Date.now();
      console.log('[OFI] Connected to Delta public WebSocket (' + this.connectionCount + ')');
      socket.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          channels: [
            { name: 'ob_l2', symbols: SYMBOLS },
            { name: 'trades', symbols: SYMBOLS }
          ]
        }
      }));
      socket.send(JSON.stringify({ type: 'enable_heartbeat' }));
    });

    socket.on('message', raw => {
      this.lastSocketActivityAt = Date.now();
      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        this.parseErrors += 1;
        return;
      }
      const events = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.d) ? parsed.d
          : (parsed?.d && typeof parsed.d === 'object' && parsed.d.type ? [parsed.d] : [parsed]);
      for (const event of events) this.handleMessage(event, Date.now());
    });

    socket.on('ping', () => {
      this.lastSocketActivityAt = Date.now();
    });
    socket.on('pong', () => {
      this.lastSocketActivityAt = Date.now();
    });
    socket.on('error', error => {
      console.warn('[OFI] WebSocket error: ' + String(error?.message || error));
      try {
        socket.terminate();
      } catch {
        // The close handler will schedule the reconnect if the socket is still active.
      }
    });
    socket.on('close', (code, reasonBuffer) => {
      if (this.ws === socket) this.ws = null;
      this.books.clear();
      this.trades = new Map(SYMBOLS.map(symbol => [symbol, []]));
      const reason = reasonBuffer ? reasonBuffer.toString().slice(0, 160) : '';
      console.warn('[OFI] WebSocket closed; code=' + code + '; reason=' + reason);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delayMs = Math.min(
      MAX_RECONNECT_DELAY_MS,
      1000 * (2 ** Math.min(this.reconnectAttempt, 5))
    );
    this.reconnectAttempt += 1;
    console.warn('[OFI] Reconnecting in ' + delayMs + ' ms');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  handleMessage(message, receivedAtMs) {
    if (!message || typeof message !== 'object') return;
    const symbol = String(message.sy || message.symbol || '').toUpperCase();
    if (!SYMBOLS.includes(symbol)) {
      if (message.type === 'subscriptions' || message.type === 'error') {
        console.log('[OFI] Server response: ' + JSON.stringify(message).slice(0, 500));
      }
      return;
    }

    if (message.type === 'ob_l2') {
      const bids = normalizeLevels(message.b, 'bid');
      const asks = normalizeLevels(message.a, 'ask');
      if (!bids.length || !asks.length) return;
      const staticImbalance = calculateStaticImbalance(bids, asks, 10).staticImbalance;
      if (staticImbalance !== null && staticImbalance > 0) {
        const previousMax = this.maxPositiveImbalanceBySymbol.get(symbol);
        this.maxPositiveImbalanceBySymbol.set(
          symbol,
          previousMax === null ? staticImbalance : Math.max(previousMax, staticImbalance)
        );
      }
      this.books.set(symbol, {
        bids,
        asks,
        receivedAtMs,
        serverTimestampMs: serverTimestampMs(message.ts ?? message.lts)
      });
      return;
    }

    if (message.type === 'trades') {
      const role = String(message.r || '').toLowerCase();
      const size = numeric(message.s);
      if (size === null || size <= 0 || !['t', 'm'].includes(role)) return;
      // r describes the buyer's role: a taker buyer is the aggressor;
      // a maker buyer means the seller was the aggressor.
      const side = role === 't' ? 'buy' : 'sell';
      const tradeList = this.trades.get(symbol) || [];
      tradeList.push({
        receivedAtMs,
        eventTimestampMs: serverTimestampMs(message.t),
        price: numeric(message.p),
        size,
        side
      });
      this.trades.set(symbol, tradeList);
      this.tradeEventsSeen += 1;
    }
  }

  checkConnection(now) {
    const socket = this.ws;
    if (socket && socket.readyState === WebSocket.OPEN
      && this.lastSocketActivityAt > 0
      && now - this.lastSocketActivityAt > IDLE_RECONNECT_AFTER_MS) {
      console.warn('[OFI] No socket activity for ' + IDLE_RECONNECT_AFTER_MS + ' ms; forcing reconnect');
      socket.terminate();
    }
  }

  createObservation(symbol, now) {
    const storedBook = this.books.get(symbol);
    const bookAgeMs = storedBook ? Math.max(0, now - storedBook.receivedAtMs) : null;
    const bookFresh = storedBook !== undefined && bookAgeMs <= ORDERBOOK_STALE_AFTER_MS;
    const book = bookFresh ? calculateStaticImbalance(storedBook.bids, storedBook.asks, 10) : null;

    const recentTrades = (this.trades.get(symbol) || [])
      .filter(trade => trade.receivedAtMs >= now - TRADE_FLOW_WINDOW_MS);
    this.trades.set(symbol, recentTrades);
    let aggressiveBuyContracts = 0;
    let aggressiveSellContracts = 0;
    for (const trade of recentTrades) {
      if (trade.side === 'buy') aggressiveBuyContracts += trade.size;
      else if (trade.side === 'sell') aggressiveSellContracts += trade.size;
    }

    const bestBid = book ? book.bestBid : null;
    const bestAsk = book ? book.bestAsk : null;
    const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const totalAggressiveContracts = aggressiveBuyContracts + aggressiveSellContracts;
    return {
      schemaVersion: 1,
      type: 'ofi_observation',
      sessionId: this.sessionId,
      observedAt: new Date(now).toISOString(),
      timestampMs: now,
      symbol,
      bookFresh,
      bookAgeMs,
      bookServerTimestampMs: bookFresh ? storedBook.serverTimestampMs : null,
      bestBid,
      bestAsk,
      midPrice,
      bidVol10: book ? book.bidVolume : null,
      askVol10: book ? book.askVolume : null,
      staticImbalance: book ? book.staticImbalance : null,
      tradeFlowWindowSeconds: 60,
      aggressiveBuyContracts60s: aggressiveBuyContracts,
      aggressiveSellContracts60s: aggressiveSellContracts,
      netAggressiveContracts60s: aggressiveBuyContracts - aggressiveSellContracts,
      tradeFlowImbalance60s: totalAggressiveContracts > 0
        ? (aggressiveBuyContracts - aggressiveSellContracts) / totalAggressiveContracts
        : null
    };
  }

  async run() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, '', 'utf8');
    const onStopSignal = signal => {
      console.warn('[OFI] Received ' + signal + '; stopping after the current write');
      this.stopRequested = true;
    };
    const onInterrupt = () => onStopSignal('SIGINT');
    const onTerminate = () => onStopSignal('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    this.signalHandlers = [['SIGINT', onInterrupt], ['SIGTERM', onTerminate]];

    const deadline = this.startedAtMs + this.durationSeconds * 1000;
    console.log('[OFI] Duration: ' + this.durationSeconds + ' seconds');
    console.log('[OFI] Symbols: ' + SYMBOLS.join(', '));
    console.log('[OFI] Output: ' + this.filePath);
    console.log('[OFI] Session: ' + this.sessionId);
    this.connect();

    let nextSampleAt = this.startedAtMs;
    try {
      while (!this.stopRequested && Date.now() < deadline) {
        const now = Date.now();
        this.checkConnection(now);
        const observations = SYMBOLS.map(symbol => this.createObservation(symbol, now));
        const lines = observations.map(row => JSON.stringify(row)).join('\n') + '\n';
        await appendFile(this.filePath, lines, 'utf8');
        this.sampleRowsWritten += SYMBOLS.length;
        for (const row of observations) {
          if (!row.bookFresh || typeof row.staticImbalance !== 'number') continue;
          this.sampledRowsWithBook.set(row.symbol, this.sampledRowsWithBook.get(row.symbol) + 1);
          if (row.staticImbalance > 0.3) {
            this.sampledHighBuyOver030.set(row.symbol, this.sampledHighBuyOver030.get(row.symbol) + 1);
          }
          if (row.staticImbalance > 0.25) {
            this.sampledHighBuyOver025.set(row.symbol, this.sampledHighBuyOver025.get(row.symbol) + 1);
          }
        }
        if (SYMBOLS.every(symbol => {
          const book = this.books.get(symbol);
          return book && now - book.receivedAtMs <= ORDERBOOK_STALE_AFTER_MS;
        })) this.freshBookSamples += SYMBOLS.length;

        nextSampleAt = Math.max(nextSampleAt + SAMPLE_INTERVAL_MS, Date.now() + SAMPLE_INTERVAL_MS);
        while (!this.stopRequested && Date.now() < deadline && Date.now() < nextSampleAt) {
          await sleep(Math.min(200, nextSampleAt - Date.now(), deadline - Date.now()));
        }
      }
    } finally {
      this.stopping = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const socket = this.ws;
      this.ws = null;
      if (socket) {
        try {
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, 'OFI collection complete');
            await sleep(200);
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          }
        } catch {
          // Collection data is already flushed to disk per sampling tick.
        }
      }
      for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    }

    console.log('[OFI] Complete. Samples written: ' + this.sampleRowsWritten);
    console.log('[OFI] Fresh-book sample count (all three symbols fresh): ' + this.freshBookSamples);
    console.log('[OFI] Trade events with recognized aggressor role: ' + this.tradeEventsSeen);
    console.log('[OFI] WebSocket connections: ' + this.connectionCount);
    console.log('[OFI] Invalid JSON frames: ' + this.parseErrors);
    console.log('[OFI] Maximum positive static imbalance observed on received L2 updates:');
    const diagnosticLines = [
      '## OFI buy-pressure diagnostics',
      '',
      'Maximum positive imbalance is tracked on each valid L2 update. Sample counts use fresh 1-second observations.',
      '',
      '| Symbol | Max positive L2 imbalance | Fresh sampled books | Samples > +0.30 | Samples > +0.25 |',
      '|---|---:|---:|---:|---:|'
    ];
    for (const symbol of SYMBOLS) {
      const maxValue = this.maxPositiveImbalanceBySymbol.get(symbol);
      const maxText = maxValue === null ? 'N/A (no valid positive L2 imbalance)' : maxValue.toFixed(6);
      const freshCount = this.sampledRowsWithBook.get(symbol);
      const over030 = this.sampledHighBuyOver030.get(symbol);
      const over025 = this.sampledHighBuyOver025.get(symbol);
      console.log(
        '[OFI] ' + symbol + ' maxPositiveImbalance=' + maxText
        + '; freshSamples=' + freshCount + '; samples>0.30=' + over030
        + '; samples>0.25=' + over025
      );
      diagnosticLines.push('| ' + symbol + ' | ' + maxText + ' | ' + freshCount + ' | ' + over030 + ' | ' + over025 + ' |');
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, diagnosticLines.join('\n') + '\n', 'utf8');
    }
    console.log('[OFI] Data file: ' + this.filePath);
    return {
      filePath: this.filePath,
      sampleRowsWritten: this.sampleRowsWritten,
      tradeEventsSeen: this.tradeEventsSeen,
      connectionCount: this.connectionCount,
      maxPositiveImbalanceBySymbol: Object.fromEntries(this.maxPositiveImbalanceBySymbol)
    };
  }
}

async function main() {
  const durationSeconds = parseDurationArg(process.argv.slice(2));
  const collector = new OfiCollector(durationSeconds);
  await collector.run();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[OFI] Collector failed: ' + String(error?.stack || error));
    process.exitCode = 1;
  });
}
