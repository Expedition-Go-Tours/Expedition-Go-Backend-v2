const axios = require('axios');

const BASE_URL = 'https://api.geoapify.com/v1/geocode';

function getApiKey() {
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key) throw new Error('GEOAPIFY_API_KEY not configured');
  return key;
}

async function search(query, limit = 5) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/search`;
  const { data } = await axios.get(url, {
    params: { text: query, apiKey, limit, format: 'json' },
    timeout: 5000,
  });
  return data;
}

async function autocomplete(query, limit = 5) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/autocomplete`;
  const { data } = await axios.get(url, {
    params: { text: query, apiKey, limit, format: 'json' },
    timeout: 5000,
  });
  return data;
}

async function reverse(lat, lng) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/reverse`;
  const { data } = await axios.get(url, {
    params: { lat, lon: lng, apiKey, format: 'json' },
    timeout: 5000,
  });
  return data;
}

async function nearby(lat, lng, radius = 10) {
  const apiKey = getApiKey();
  const url = `https://api.geoapify.com/v2/places`;
  const { data } = await axios.get(url, {
    params: {
      apiKey,
      filter: `circle:${lng},${lat},${radius * 1000}`,
      bias: `proximity:${lng},${lat}`,
      limit: 20,
    },
    timeout: 5000,
  });
  return data;
}

module.exports = { search, autocomplete, reverse, nearby };
