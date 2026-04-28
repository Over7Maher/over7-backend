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

/**
 * Permanently deletes all photos uploaded by a user from Cloudinary.
 * Called by the RGPD purge cron after the 30-day grace period.
 *
 * Uses delete_resources_by_prefix to wipe all assets under
 * over7/users/{userId}/ in one API call, then delete_folder to remove
 * the empty folder. Folder removal is best-effort — logs a warning if
 * it fails (e.g. nested empty subdirs, already gone) but does not throw.
 *
 * Returns { deleted: number, folderRemoved: boolean } for logging.
 * Throws on resource-deletion API failure — caller catches and continues
 * to the DB delete (orphan assets are acceptable, can be swept later).
 */
async function deleteUserPhotos(userId) {
  const prefix = `over7/users/${userId}/`;

  const deletion      = await cloudinary.api.delete_resources_by_prefix(prefix);
  const deletedCount  = Object.keys(deletion?.deleted || {}).length;

  let folderRemoved = false;
  try {
    await cloudinary.api.delete_folder(`over7/users/${userId}`);
    folderRemoved = true;
  } catch (err) {
    console.warn(`[cloudinary] could not delete folder ${prefix}:`, err.message);
  }

  return { deleted: deletedCount, folderRemoved };
}

module.exports = { cloudinary, uploadPhoto, deleteUserPhotos };
