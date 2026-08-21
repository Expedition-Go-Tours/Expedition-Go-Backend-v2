import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, TOUR_ID, TOUR_SLUG } from '../config.js';

const listingFailRate = new Rate('listing_errors');
const detailFailRate = new Rate('detail_errors');
const checkoutFailRate = new Rate('checkout_errors');

export const options = {
  stages: [
    { duration: '1m', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 50 },
    { duration: '30s', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.02'],
    listing_errors: ['rate<0.01'],
    detail_errors: ['rate<0.01'],
    checkout_errors: ['rate<0.02'],
  },
};

export default function () {
  const r = Math.random();

  if (r < 0.60) {
    const res = http.get(`${BASE_URL}/api/expedition/tours`, {
      headers: { 'Accept': 'application/json' },
    });
    const ok = check(res, { 'listing ok': (r2) => r2.status === 200 });
    listingFailRate.add(!ok);

  } else if (r < 0.85) {
    const detail = http.get(`${BASE_URL}/api/expedition/tours/${TOUR_SLUG}`, {
      headers: { 'Accept': 'application/json' },
    });
    const calc = http.post(
      `${BASE_URL}/api/expedition/checkout/calculate`,
      JSON.stringify({
        tourId: TOUR_ID,
        travelDate: '2026-08-15',
        travelers: { adults: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    const ok = check(detail, { 'detail ok': (r2) => r2.status === 200 })
      && check(calc, { 'calc ok': (r2) => r2.status === 200 && JSON.parse(r2.body).data?.pricing?.total > 0 });
    detailFailRate.add(!ok);

  } else {
    const calc = http.post(
      `${BASE_URL}/api/expedition/checkout/calculate`,
      JSON.stringify({
        tourId: TOUR_ID,
        travelDate: '2026-08-15',
        travelers: { adults: 2 },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    const ok = check(calc, { 'checkout calc ok': (r2) => r2.status === 200 && JSON.parse(r2.body).data?.pricing?.total > 0 });
    checkoutFailRate.add(!ok);
  }

  sleep(0.5);
}
