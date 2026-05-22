function cloudinaryUrl(url, width = 800) {
  if (typeof url !== 'string') return url;

  const { CLOUDINARY_CLOUD_NAME } = process.env;
  if (CLOUDINARY_CLOUD_NAME && !url.startsWith('http://') && !url.startsWith('https://')) {
    return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/w_${width},q_auto,f_auto/v1/${url}`;
  }

  return url
    .replace(/(\/upload\/)(?:w_[^/]+,q_auto,f_auto\/)+/, '$1')
    .replace('/upload/', `/upload/w_${width},q_auto,f_auto/`);
}

module.exports = { cloudinaryUrl };