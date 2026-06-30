const catchAsync = require('../utils/catchAsync');
const locationService = require('../utils/locationService');
const validator = require('../utils/locationValidator');

exports.search = catchAsync(async (req, res) => {
  const { query, limit } = validator.validateSearchQuery(req);
  const results = await locationService.search(query, limit);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.autocomplete = catchAsync(async (req, res) => {
  const { query, limit } = validator.validateAutocompleteQuery(req);
  const results = await locationService.autocomplete(query, limit);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.reverse = catchAsync(async (req, res) => {
  const { lat, lng } = validator.validateReverseQuery(req);
  const results = await locationService.reverse(lat, lng);
  res.status(200).json({ status: 'success', data: { results } });
});

exports.nearby = catchAsync(async (req, res) => {
  const { lat, lng, radius } = validator.validateNearbyQuery(req);
  const results = await locationService.nearby(lat, lng, radius);
  res.status(200).json({ status: 'success', data: { results } });
});
