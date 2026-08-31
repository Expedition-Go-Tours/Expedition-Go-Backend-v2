import http from 'k6/http';
import { check } from 'k6';
import { sleep } from 'k6';
import { BASE_URL, SMOKE_THRESHOLDS } from '../config.js';

const REAL_SLUG = __ENV.TOUR_SLUG || 'accra-culture-walk-fantasy-coffins-art-gallery-beaches';

export const options = {
  vus: __ENV.VUS ? Number(__ENV.VUS) : 5,
  duration: __ENV.DURATION || '45s',
  thresholds: SMOKE_THRESHOLDS,
};

export default function () {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health returns 200': (r) => r.status === 200 });

  const tours = http.get(`${BASE_URL}/api/expedition/tours`);
  check(tours, {
    'tours returns 200': (r) => r.status === 200,
    'tours has results': (r) => r.status === 200 && JSON.parse(r.body).data.tours.length > 0,
  });

  const detail = http.get(`${BASE_URL}/api/expedition/tours/${REAL_SLUG}`);
  check(detail, {
    'tour detail returns 200': (r) => r.status === 200,
    'tour detail slug matches': (r) => r.status === 200 && JSON.parse(r.body).data.tour.tour.slug === REAL_SLUG,
  });

  sleep(2 + Math.random() * 2);
}
