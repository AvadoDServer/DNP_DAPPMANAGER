const shell = require("../utils/shell");
const isIp = require("is-ip");
const logs = require("../logs.js")(module);

async function getInternalIp({ silent } = {}) {
  try {
    const internalIp = await shell(
      `docker run --rm --net=host --pid=host --ipc=host --volume /:/host  busybox  chroot /host /sbin/ip route | grep -v 172 | grep -v default | awk '{ print $9 }'`,
      { trim: true }
    );
    const cleanIp = isIp(internalIp) ? internalIp : null;
    logs.info(`Got internal IP: ${cleanIp}`);
    return cleanIp;
  } catch (e) {
    if (!silent) logs.error(`Error getting internal IP: ${e.message}`);
  }
}

module.exports = getInternalIp;
