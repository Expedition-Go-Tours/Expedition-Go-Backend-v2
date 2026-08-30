const axios = require('axios');

const BASE_URL = 'https://nominatim.openstreetmap.org';

let lastRequestTime = 0;

async function rateLimitedRequest(url, params) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - elapsed));
  }
  lastRequestTime = Date.now();

  const { data } = await axios.get(url, {
    params,
    headers: {
      'User-Agent': 'TravioAfricaBackend/1.0 (support@travioafrica.com)',
      'Accept-Language': 'en',
    },
    timeout: 8000,
  });
  return data;
}

async function search(query, limit = 5) {
  const data = await rateLimitedRequest(`${BASE_URL}/search`, {
    q: query,
    format: 'json',
    addressdetails: 1,
    limit,
  });
  return Array.isArray(data) ? data : [];
}

async function reverse(lat, lng) {
  const data = await rateLimitedRequest(`${BASE_URL}/reverse`, {
    lat,
    lon: lng,
    format: 'json',
    addressdetails: 1,
  });
  return data;
}

module.exports = { search, reverse };
