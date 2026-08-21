import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, TOUR_ID } from '../config.js';

export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '2m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

const PAYLOAD_TEMPLATES = [
  { adults: 1 },
  { adults: 2 },
  { adults: 2, children: 1 },
];

export default function () {
  const travelers = PAYLOAD_TEMPLATES[__ITER % PAYLOAD_TEMPLATES.length];

  const calc = http.post(
    `${BASE_URL}/api/expedition/checkout/calculate`,
    JSON.stringify({
      tourId: TOUR_ID,
      travelDate: '2026-08-15',
      travelers,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(calc, {
    'calculate status 200': (r) => r.status === 200,
    'calculate has pricing': (r) => JSON.parse(r.body).data?.pricing?.total > 0,
  });

  sleep(1);
}
