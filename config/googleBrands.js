/**
 * Per-brand Google OAuth credentials.
 *
 * Each branded storefront has its own Google Cloud project + OAuth client so
 * the consent screen shows that brand's own domain. Credentials are read from
 * the environment; a brand whose credentials are absent simply falls back to
 * the default (TravioAfrica) client, preserving single-brand behaviour.
 */

const { BRANDS } = require('./brands');

// Keys used by auth: 'default' (TravioAfrica legacy), 'ghana', 'expedition'.
const BRAND_GOOGLE_ENV = {
  default: BRANDS.africa.googleOAuth,
  ghana: BRANDS.ghana.googleOAuth,
  expedition: BRANDS.expedition.googleOAuth,
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
