/**
 * CLIP Microservice Client
 *
 * Communicates with the Python CLIP service running on localhost:5001.
 * Provides image classification, embeddings, and quality scoring.
 */

const CLIP_URL = process.env.CLIP_URL || 'http://127.0.0.1:5001';
const TIMEOUT_MS = 30_000;

async function clipFetch(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${CLIP_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`CLIP ${endpoint} failed (${res.status}): ${text}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Zero-shot classify an image into categories.
 * @param {string} imageUrl - Cloudinary/CDN URL
 * @param {string[]} [candidateLabels] - optional override labels
 * @returns {Promise<{label: string, confidence: number, allScores: Record<string,number>, subjects: string[]}>}
 */
async function classifyImage(imageUrl, candidateLabels) {
  const body = { imageUrl };
  if (candidateLabels?.length) body.candidateLabels = candidateLabels;
  return clipFetch('/classify', body);
}

/**
 * Get CLIP image embedding (512-dim vector).
 * @param {string} imageUrl
 * @returns {Promise<{embedding: number[]}>}
 */
async function embedImage(imageUrl) {
  return clipFetch('/embed/image', { imageUrl });
}

/**
 * Get CLIP text embedding (512-dim vector).
 * @param {string} text
 * @returns {Promise<{embedding: number[]}>}
 */
async function embedText(text) {
  return clipFetch('/embed/text', { text });
}

/**
 * Image quality heuristic.
 * @param {string} imageUrl
 * @returns {Promise<{score: number, issues: string[]}>}
 */
async function scoreQuality(imageUrl) {
  return clipFetch('/quality', { imageUrl });
}

/**
 * Check if CLIP service is healthy.
 * @returns {Promise<boolean>}
 */
async function isHealthy() {
  try {
    const res = await fetch(`${CLIP_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

module.exports = {
  classifyImage,
  embedImage,
  embedText,
  scoreQuality,
  isHealthy,
};
