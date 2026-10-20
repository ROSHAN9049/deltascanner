function timestampFor(row) {
  const value = row?.created_at || row?.data?.runCompletedAt;
  const milliseconds = value ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function nonNegativeCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function retentionStatus(row) {
  return String(row?.data?.status || '').toUpperCase();
}

export function summarizeRetentionHealth(rows, { defaultConfigDays = 1 } = {}) {
  const fallbackDays = Number.isSafeInteger(defaultConfigDays) && defaultConfigDays >= 1 && defaultConfigDays <= 3650
    ? defaultConfigDays
    : 1;
  const summaries = (Array.isArray(rows) ? rows : [])
    .filter(row =>
      row?.message === '[Retention] Run summary' &&
      row.data && typeof row.data === 'object' &&
      ['SUCCESS', 'FAILURE'].includes(retentionStatus(row)) &&
      timestampFor(row) !== null
    )
    .map(row => ({ row, timestampMs: timestampFor(row) }))
    .sort((a, b) => b.timestampMs - a.timestampMs);

  const latest = summaries[0] || null;
  const latestSuccess = summaries.find(item => retentionStatus(item.row) === 'SUCCESS') || null;
  let consecutiveFailures = 0;
  for (const item of summaries) {
    if (retentionStatus(item.row) !== 'FAILURE') break;
    consecutiveFailures += 1;
  }

  const latestConfigDays = Number(latest?.row?.data?.configDays);
  return {
    lastRun: latest ? new Date(latest.timestampMs).toISOString() : null,
    lastSuccess: latestSuccess ? new Date(latestSuccess.timestampMs).toISOString() : null,
    rowsDeleted: nonNegativeCount(latest?.row?.data?.rowsDeleted),
    consecutiveFailures,
    configDays: Number.isSafeInteger(latestConfigDays) && latestConfigDays >= 1 && latestConfigDays <= 3650
      ? latestConfigDays
      : fallbackDays
  };
}
