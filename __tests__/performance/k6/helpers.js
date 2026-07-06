import http from 'k6/http';

export function authenticate(baseURL, email, password) {
  const res = http.post(`${baseURL}/api/auth/login`, JSON.stringify({
    email,
    password,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  if (res.status !== 200) {
    console.log(`Login failed: ${res.status} ${res.body}`);
    return null;
  }

  const body = JSON.parse(res.body);
  return body.data.accessToken;
}

export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}
