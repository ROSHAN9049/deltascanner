// Continuous opportunity engine is intentionally disabled at build time.
// The previous build-time source-rewrite implementation could corrupt
// src/both.jsx and break Vite. Continuous opportunity logic will be added
// directly to the React source after the production build is stable.
console.log('Opportunity engine build patch disabled; preserving src/both.jsx');
