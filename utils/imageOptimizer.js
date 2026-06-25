function cloudinaryUrl(url, width = 800) {
  if (typeof url !== 'string') return url;
  width = Math.min(Math.max(parseInt(width) || 800, 100), 2000);

  const { CLOUDINARY_CLOUD_NAME } = process.env;
  if (CLOUDINARY_CLOUD_NAME && !url.startsWith('http://') && !url.startsWith('https://')) {
    return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/w_${width},q_80,f_auto/v1/${url}`;
  }

  const uploadMarker = '/upload/';
  const idx = url.indexOf(uploadMarker);
  if (idx === -1) return url;

  const afterUpload = url.slice(idx + uploadMarker.length);

  // Split afterUpload into segments
  const parts = afterUpload.split('/');

  // Identify:
  //   - transformation segments (contain underscores, but not version)
  //   - version segment (v<digits>)
  //   - the actual path (folder + filename)
  let version = '';
  let pathParts = null;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (/^v\d+$/i.test(seg)) {
      version = seg + '/';
      pathParts = parts.slice(i + 1);
      break;
    }
    if (!seg.includes('_')) {
      pathParts = parts.slice(i);
      break;
    }
  }

  // If neither version nor known path structure found, fall through to end
  const path = pathParts ? pathParts.join('/') : parts.join('/');

  // Get the part before /upload/ (e.g., "https://res.cloudinary.com/dfpagrtoy/image")
  const beforeUpload = url.slice(0, idx);

  return `${beforeUpload}${uploadMarker}w_${width},q_80,f_auto/${version}${path}`;
}

module.exports = { cloudinaryUrl };