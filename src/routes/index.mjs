// ESM wrapper for the CommonJS implementation. Do not add business
// logic here — keep the source of truth in the .cjs file.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registerLedgerStatusRoute = require('./ledger-status.cjs');

export default registerLedgerStatusRoute;
