/**
 * Options candidates remain analysis-only until spread legs, maximum loss,
 * dedicated credentials, and contract mappings are independently verified.
 * Changing this value requires a reviewed code change; route configuration
 * alone must never enable Options entry signals.
 */
export const OPTIONS_EXECUTION_ALLOWED = false;

export const OPTIONS_EXECUTION_LOCK_REASON =
  'Options execution locked pending independent verification of spread legs, defined maximum loss, dedicated credentials, and contract mappings.';

export function isOptionsExecutionAllowed() {
  return OPTIONS_EXECUTION_ALLOWED === true;
}
