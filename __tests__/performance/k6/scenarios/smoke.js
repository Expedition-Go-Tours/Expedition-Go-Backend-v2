import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, SMOKE_THRESHOLDS, TOUR_SLUG, TOUR_ID, CUSTOMER_EMAIL, CUSTOMER_PASSWORD } from '../config.js';
import { authenticate, authHeaders } from '../helpers.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: SMOKE_THRESHOLDS,
};

export default function () {
  // 1. Health check
  const health = http.get(`${BASE_URL}/health`);
  check(health, {
    'health returns 200': (r) => r.status === 200,
  });

  // 2. List expedition tours
  const tours = http.get(`${BASE_URL}/api/expedition/tours`);
  check(tours, {
    'tours returns 200': (r) => r.status === 200,
    'tours has results': (r) => JSON.parse(r.body).data.tours.length > 0,
  });

  // 3. Get tour by slug
  const detail = http.get(`${BASE_URL}/api/expedition/tours/${TOUR_SLUG}`);
  check(detail, {
    'tour detail returns 200': (r) => r.status === 200,
    'tour detail has correct slug': (r) => JSON.parse(r.body).data.tour.tour.slug === TOUR_SLUG,
  });

  // 4. Calculate checkout pricing (public)
  const calc = http.post(
    `${BASE_URL}/api/expedition/checkout/calculate`,
    JSON.stringify({
      tourId: TOUR_ID,
      travelDate: '2026-08-15',
      travelers: { adults: 2 },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(calc, {
    'calculate returns 200': (r) => r.status === 200,
    'calculate has pricing': (r) => JSON.parse(r.body).data.pricing.total > 0,
  });

  // 5. Authenticate as customer
  const token = authenticate(BASE_URL, CUSTOMER_EMAIL, CUSTOMER_PASSWORD);
  check(token, {
    'authentication succeeded': (t) => t !== null,
  });
  if (!token) return;

  // 6. Get expedition wishlist (authenticated)
  const wishlist = http.get(`${BASE_URL}/api/expedition/wishlist`, authHeaders(token));
  check(wishlist, {
    'wishlist returns 200': (r) => r.status === 200,
  });

  // 7. Get expedition bookings (authenticated)
  const bookings = http.get(`${BASE_URL}/api/expedition/bookings`, authHeaders(token));
  check(bookings, {
    'bookings returns 200': (r) => r.status === 200,
    'bookings has pagination': (r) => {
      if (r.status !== 200) return false;
      const body = JSON.parse(r.body);
      return body.pagination && typeof body.pagination.totalCount === 'number';
    },
  });
}
