const hostPassword = require("modules/hostPassword");

/**
 * Whether the box's login user `avado` no longer has the factory password
 * `avado` (named as DAppNode's call). The Admin asks on page load; the answer
 * is cached for a minute. Not a user action and never logged.
 *
 * @returns {object} result: true = changed from the factory password,
 *   false = still `avado`, null = could not tell (no `avado` user, or the
 *   check could not run)
 */
const passwordIsSecure = async () => {
  const isDefault = await hostPassword.isDefaultPassword();
  return {
    message: isDefault === null ? "Could not check the box password" : isDefault ? "The box password is the factory one" : "The box password was changed",
    result: isDefault === null ? null : !isDefault
  };
};

module.exports = passwordIsSecure;
