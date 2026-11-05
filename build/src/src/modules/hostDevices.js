const getDappmanagerImage = require("utils/getDappmanagerImage");
const shell = require("utils/shell");
const { isAllowedHostDevice } = require("utils/composeLimits");
const logs = require("logs.js")(module);

/**
 * Which of `paths` exist on the host. The DAPPMANAGER's own /dev is not the
 * host's, so a short container of the DAPPMANAGER image (always on the box)
 * looks at the host's /dev, read-only and without network.
 * Only allowed device paths (composeLimits) are ever put in the command.
 * @param {string[]} paths host device paths, e.g. ["/dev/ttyUSB0"]
 * @returns {Promise<string[]|undefined>} the paths that exist; undefined when
 *   the check could not run (the caller then keeps every device)
 */
async function hostDevicesPresent(paths) {
  const wanted = [...new Set((paths || []).filter(isAllowedHostDevice))];
  if (!wanted.length) return [];
  try {
    const image = await getDappmanagerImage();
    const tests = wanted.map(p => `[ -e '/host${p}' ] && echo '${p}'`).join("; ");
    const out = await shell(
      `docker run --rm --network none --log-driver none -v /dev:/host/dev:ro --entrypoint sh ${image} -c "${tests}; true"`,
      { timeout: 60 * 1000 }
    );
    const found = new Set(String(out || "").split(/\r?\n/).map(s => s.trim()));
    return wanted.filter(p => found.has(p));
  } catch (e) {
    logs.warn(`Could not check the host devices ${wanted.join(", ")}: ${e.message}`);
    return undefined;
  }
}

module.exports = { hostDevicesPresent };
