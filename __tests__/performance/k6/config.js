export const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';

export const SMOKE_THRESHOLDS = {
  http_req_duration: ['p(95)<2000'],
  http_req_failed: ['rate<0.01'],
};

export const TOUR_SLUG = 'perf-safari-adventure';
export const TOUR_ID = '9b55dcd5-5b1d-4a3e-ac87-3d3c443e9d93';

export const CUSTOMER_EMAIL = 'perf-customer@test.com';
export const CUSTOMER_PASSWORD = 'Password123!';

export const LOAD_THRESHOLDS = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
};
