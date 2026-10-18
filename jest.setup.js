process.env.NODE_ENV = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: './.env' });

// `.env` points DATABASE_URL at the local *dev* database (`travio`). Several
// DB-gated tests write — `user.integration` creates users and only cleans up
// the `integration-*` ones, `regionFallback` deletes attractions — so pointed
// at dev they would mutate real development data and leave `dup-*@test.com`
// rows behind.
//
// TEST_DATABASE_URL is the override for an isolated database (see
// scripts/test-db-up.sh, which provisions `travio_test`). It is applied *after*
// dotenv so it wins over `.env`, and it has to happen here as well as in
// jest.globalSetup.js: globalSetup runs in the runner process, while this file
// runs inside every worker, and env changes made in globalSetup are not
// guaranteed to reach the workers.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DIRECT_URL) {
  process.env.DIRECT_URL = process.env.TEST_DIRECT_URL;
}
