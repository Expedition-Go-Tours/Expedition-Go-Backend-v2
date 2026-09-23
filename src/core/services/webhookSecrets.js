/**
 * Candidate HMAC keys for a Svix/Resend webhook secret.
 *
 * The Svix spec signs with the base64 portion AFTER the `whsec_` prefix
 * (decoded to raw bytes by standardwebhooks), but this codebase historically
 * verified with the full env string — and that DID verify a real Resend
 * delivery event (Sep 22), so the exact convention differs by sender/version.
 * Accept every derivation of a secret we already fully control: knowing the
 * secret means knowing all of these, so this adds no attack surface.
 *
 * Returns strings and Buffers — crypto.createHmac accepts both.
 */
function hmacKeysFor(secret) {
  if (!secret) return [];
  const keys = [secret];
  const stripped = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (stripped !== secret) keys.push(stripped);
  if (/^[A-Za-z0-9+/=_-]+$/.test(stripped)) {
    const raw = Buffer.from(stripped, 'base64');
    if (raw.length >= 16) keys.push(raw);
  }
  return keys;
}

module.exports = { hmacKeysFor };
