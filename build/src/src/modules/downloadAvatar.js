const ipfs = require("modules/ipfs");
const db = require("../db");
const formatAndCompressAvatar = require("utils/formatAndCompressAvatar");
const Joi = require("joi");

/**
 * Handles the download of a JSON DNP manifest.
 * This function handles cache and type validation, while the IPFS
 * stream and download is abstracted away.
 *
 * 1. Check if cache exist and validate it
 * 2. Cat stream to file system
 * 3. Validate downloaded image. Store result in cache
 *
 * @param {string} hash "QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ"
 */

async function downloadAvatar(hash) {
  if (!hash || typeof hash !== "string")
    throw Error(`arg hash must be a string: ${hash}`);

  /**
   * 1. Check if cache exist and validate it
   */
  const avatarCache = db.get(hash);
  const cacheValidation = await validateAvatar(avatarCache);
  if (cacheValidation.success) return cacheValidation.manifest;

  /**
   * 2. Cat stream to file system
   * Data from IPFS is the image buffer. It must be stringified as base64
   * and prepend the mime type
   */
  let avatarBuffer;
  try {
    avatarBuffer = await ipfs.cat(hash, { asBuffer: true });
  } catch (e) {
    e.message = `Can't download avatar: ${e.message}`;
    throw e;
  }
  const avatar = await formatAndCompressAvatar(avatarBuffer);

  /**
   * 3. Validate downloaded image
   * Store the compressed avatar in cache
   */
  const validation = await validateAvatar(avatar);
  if (!validation.success)
    throw Error(
      `Downloaded image from ${hash} failed validation: ${validation.message}`
    );

  await db.set(hash, avatar);
  return avatar;
}

/**
 * Validates a PNG avatar
 *
 * 1. The file at path exists
 *
 * @param {string} avatar, base64 encoded dataUrl
 * @returns {object} A result object, so it doesn't have to be handled with try / catch
 * {
 *   success: true, {bool}
 *   message: "File size is 0 bytes" {string}
 * }
 */
async function validateAvatar(avatar) {
  if (!avatar)
    return {
      success: false,
      message: "Empty string"
    };

  /**
   * avatar must be 'data:image/png;base64,VE9PTUFOWVNFQ1JFVFM='
   * on error: result = { error: <Error obj> }
   */
  const result = Joi.validate(avatar, Joi.string().dataUri());
  if (result.error)
    return {
      success: false,
      message: (result.error.message || "").replace("value", "avatar")
    };

  // If all okay, return success
  return { success: true };
}

module.exports = downloadAvatar;
