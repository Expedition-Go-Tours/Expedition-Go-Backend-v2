/**
 * Per-brand Google OAuth credentials.
 *
 * Each branded storefront has its own Google Cloud project + OAuth client so
 * the consent screen shows that brand's own domain. Credentials are read from
 * the environment; a brand whose credentials are absent simply falls back to
 * the default (TravioAfrica) client, preserving single-brand behaviour.
 */

const BRAND_GOOGLE_ENV = {
  default: {
    strategy: 'google',
    idVar: 'GOOGLE_CLIENT_ID',
    secretVar: 'GOOGLE_CLIENT_SECRET',
    callbackVar: 'GOOGLE_CALLBACK_URL',
    callbackFallback: 'http://localhost:5000/api/auth/google/callback',
  },
  ghana: {
    strategy: 'google-ghana',
    idVar: 'GOOGLE_CLIENT_ID_GHANA',
    secretVar: 'GOOGLE_CLIENT_SECRET_GHANA',
    callbackVar: 'GOOGLE_CALLBACK_URL_GHANA',
    callbackFallback: 'https://api.travioghana.com/api/auth/google/callback',
  },
  expedition: {
    strategy: 'google-expedition',
    idVar: 'GOOGLE_CLIENT_ID_EXPEDITION',
    secretVar: 'GOOGLE_CLIENT_SECRET_EXPEDITION',
    callbackVar: 'GOOGLE_CALLBACK_URL_EXPEDITION',
    callbackFallback: 'https://api.expeditiongotours.com/api/auth/google/callback',
  },
};

/** Resolve the Google client config for a brand (never throws). */
function googleConfigFor(brand) {
  const def = BRAND_GOOGLE_ENV[brand] || BRAND_GOOGLE_ENV.default;
  return {
    brand: BRAND_GOOGLE_ENV[brand] ? brand : 'default',
    strategy: def.strategy,
    clientID: process.env[def.idVar] || '',
    clientSecret: process.env[def.secretVar] || '',
    callbackURL: process.env[def.callbackVar] || def.callbackFallback,
  };
}

function isGoogleBrandConfigured(brand) {
  const cfg = googleConfigFor(brand);
  return Boolean(cfg.clientID && cfg.clientSecret);
}

/** Strategy name to authenticate with, falling back to the default brand. */
function googleStrategyFor(brand) {
  return isGoogleBrandConfigured(brand)
    ? googleConfigFor(brand).strategy
    : googleConfigFor('default').strategy;
}

/** Client ID whose audience should validate a One Tap credential for a brand. */
function googleClientIdFor(brand) {
  const cfg = googleConfigFor(brand);
  return cfg.clientID || googleConfigFor('default').clientID;
}

module.exports = {
  BRAND_GOOGLE_ENV,
  googleConfigFor,
  isGoogleBrandConfigured,
  googleStrategyFor,
  googleClientIdFor,
};
