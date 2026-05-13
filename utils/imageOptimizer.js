function cloudinaryUrl(url, width = 800) {
  if (typeof url !== 'string') return url;

  return url.replace(
    '/upload/',
    `/upload/w_${width},q_auto,f_auto/`
  );
}

module.exports = { cloudinaryUrl };