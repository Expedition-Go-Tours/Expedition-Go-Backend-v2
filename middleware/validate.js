const AppError = require('../utils/appError');

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const issues = result.error.issues;
    const first = issues[0];
    const message = `${first.path.join('.')}: ${first.message}`;
    return next(new AppError(message, 400));
  }

  const { body, query, params } = result.data;
  req.body = body;
  req.query = query;
  req.params = params;
  next();
};

module.exports = validate;
