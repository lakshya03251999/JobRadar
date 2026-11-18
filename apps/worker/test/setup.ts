// Provide dummy env so config.ts validation passes during unit tests.
// These are never used to make real network calls in the pure-function tests.
process.env.DATABASE_URL ??= "file:./dev.db";
process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-secret";
process.env.GOOGLE_REDIRECT_URI ??= "http://localhost:4000/auth/google/callback";
process.env.TOKEN_ENC_KEY ??= "0".repeat(64);
process.env.OPENROUTER_API_KEY ??= "sk-or-test";
process.env.DEFAULT_TZ ??= "Asia/Kolkata";
process.env.CONFIDENCE_THRESHOLD ??= "0.7";
