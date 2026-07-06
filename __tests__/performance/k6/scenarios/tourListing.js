import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, LOAD_THRESHOLDS } from '../config.js';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: LOAD_THRESHOLDS,
};

export default function () {
  const res = http.get(`${BASE_URL}/api/expedition/tours`, {
    headers: { 'Accept': 'application/json' },
  });
  check(res, {
    'tours status 200': (r) => r.status === 200,
    'tours has data': (r) => JSON.parse(r.body).status === 'success',
  });
  sleep(1);
}
