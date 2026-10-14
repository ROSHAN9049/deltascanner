/** Return a YYYY-MM-DD date key in India Standard Time (Asia/Kolkata). */
export function indiaDateKey(value) {
  const input = arguments.length === 0 ? new Date() : value;
  if (input === null || input === undefined || input === '') return null;
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) return null;
  return values.year + '-' + values.month + '-' + values.day;
}

export function isSameIndiaDate(value, reference = new Date()) {
  const valueKey = indiaDateKey(value);
  return valueKey !== null && valueKey === indiaDateKey(reference);
}
