const axios = require('axios');

const BASE_URL = 'https://photon.komoot.io/api';
const REVERSE_URL = 'https://photon.komoot.io/reverse';

async function search(query, limit = 5) {
  const { data } = await axios.get(BASE_URL, {
    params: { q: query, limit },
    timeout: 5000,
  });
  return data;
}

async function reverse(lat, lng) {
  const { data } = await axios.get(REVERSE_URL, {
    params: { lat, lon: lng },
    timeout: 5000,
  });
  return data;
}

module.exports = { search, reverse };
