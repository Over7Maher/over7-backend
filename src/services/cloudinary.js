const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/**
 * Upload a single photo buffer to Cloudinary.
 * - Stored under over7/users/{userId}/
 * - Resized to fit within 800×800 px (no upscale)
 * - Converted to WebP
 * Returns the secure HTTPS URL.
 */
function uploadPhoto(fileBuffer, userId) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder:         `over7/users/${userId}`,
        resource_type:  'image',
        format:         'webp',
        transformation: [
          { width: 800, height: 800, crop: 'limit' },
        ],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );
    uploadStream.end(fileBuffer);
  });
}

module.exports = { cloudinary, uploadPhoto };
