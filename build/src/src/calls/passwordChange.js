const hostPassword = require("modules/hostPassword");

/**
 * Changes the password of the box's login user `avado` (SSH, sudo, the
 * local console). The current password is checked on the host first.
 *
 * The passwords reach the host on a container's stdin only and are never
 * logged: registerHandler hides every kwarg whose name says password before
 * the activity log or a log line sees it, and every error is a plain
 * sentence that holds neither password.
 *
 * @param {string} currentPassword
 * @param {string} newPassword at least 8 characters, not "avado", no line
 *   breaks or other control characters
 */
const passwordChange = async ({ currentPassword, newPassword } = {}) => {
  await hostPassword.changePassword({ currentPassword, newPassword });
  return {
    message: "Box password changed",
    logMessage: true,
    userAction: true
  };
};

module.exports = passwordChange;
