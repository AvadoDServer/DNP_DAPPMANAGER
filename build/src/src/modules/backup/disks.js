const { spawn } = require("child_process");
const getDappmanagerImage = require("utils/getDappmanagerImage");

/**
 * Disks the owner can use for backups: plugged-in USB disks and sticks, and
 * any disk or partition labelled AVADO… (for a second internal disk).
 * The box's own disk is never offered.
 *
 * lsblk runs on the host (chroot from a short container of the DAPPMANAGER
 * image, the same way the diagnostics read the host): the DAPPMANAGER's own
 * /dev and /sys are not the host's.
 */

const USABLE_FS = new Set(["ext4", "ext3", "ext2", "exfat", "vfat", "ntfs", "xfs", "btrfs"]);
const FS_NAMES = {
  exfat: "exFAT",
  vfat: "FAT32",
  ntfs: "NTFS",
  ext4: "ext4",
  ext3: "ext3",
  ext2: "ext2",
  xfs: "XFS",
  btrfs: "Btrfs"
};
const SYSTEM_MOUNTS = /^(\/|\/boot(\/.*)?|\/usr(\/.*)?|\/var(\/.*)?|\/home|\/opt|\/srv|\[SWAP\])$/;
const LSBLK_COLS = "NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,TRAN,HOTPLUG,RM,MODEL,VENDOR,PKNAME";

const BLKID_MARK = "#AVADO-BLKID";

/** `blkid -o export`: blank-line separated KEY=value blocks, by DEVNAME */
function parseBlkid(text) {
  const byDev = {};
  for (const block of String(text || "").split(/\n\s*\n/)) {
    const o = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    if (o.DEVNAME) byDev[o.DEVNAME] = o;
  }
  return byDev;
}

/** Fills in format, label and id that lsblk left empty */
function mergeBlkid(lsblkJson, byDev) {
  const walk = list => {
    for (const d of list || []) {
      const b = byDev[d.path || `/dev/${d.name}`];
      if (b) {
        if (!d.fstype && b.TYPE) d.fstype = b.TYPE;
        if (!d.label && b.LABEL) d.label = b.LABEL;
        if (!d.uuid && b.UUID) d.uuid = b.UUID;
      }
      walk(d.children);
    }
  };
  walk(lsblkJson && lsblkJson.blockdevices);
  return lsblkJson;
}

const bool = v => v === true || v === 1 || v === "1" || v === "true";

/** Flat list of lsblk devices, children included, each with its parent's name */
function flatten(devices, parent = null, out = []) {
  for (const d of devices || []) {
    out.push({ ...d, _parent: parent });
    if (Array.isArray(d.children)) flatten(d.children, d, out);
  }
  return out;
}

/**
 * @param {object} lsblkJson output of lsblk -J -b -o LSBLK_COLS
 * @returns {Array<{ id, path, name, size, fstype, fsName, label, model, usable, reason }>}
 *   id = filesystem UUID (what the settings keep; the /dev name can change)
 */
function parseDisks(lsblkJson) {
  const all = flatten((lsblkJson && lsblkJson.blockdevices) || []);
  const byName = new Map(all.map(d => [d.name, d]));
  // Top-level disk of a device
  const rootOf = d => {
    let cur = d;
    let guard = 0;
    while (guard++ < 10) {
      const parentName = cur.pkname || (cur._parent && cur._parent.name);
      if (!parentName || !byName.has(parentName)) return cur;
      cur = byName.get(parentName);
    }
    return cur;
  };
  // Disks that hold anything the system runs from
  const systemDisks = new Set();
  for (const d of all) {
    if (d.mountpoint && SYSTEM_MOUNTS.test(d.mountpoint)) systemDisks.add(rootOf(d).name);
    if (d.fstype === "LVM2_member" || d.fstype === "linux_raid_member" || d.fstype === "crypto_LUKS")
      systemDisks.add(rootOf(d).name);
  }
  const out = [];
  for (const d of all) {
    if (!d.fstype || d.type === "rom") continue;
    if (!["part", "disk", "loop"].includes(d.type)) continue;
    const root = rootOf(d);
    const tran = d.tran || root.tran || "";
    const removable = tran === "usb" || bool(d.hotplug) || bool(root.hotplug) || bool(d.rm) || bool(root.rm);
    const labelled = /^avado/i.test(d.label || "");
    if (!removable && !labelled) continue;
    if (systemDisks.has(root.name)) continue;
    if (d.type === "loop" && !labelled) continue;
    const fstype = String(d.fstype).toLowerCase();
    const usable = USABLE_FS.has(fstype) && Boolean(d.uuid);
    let reason;
    if (!USABLE_FS.has(fstype)) reason = "This disk's format can't be used. Use a disk formatted as exFAT, NTFS or ext4.";
    else if (!d.uuid) reason = "This disk has no ID, so it can't be found again later.";
    const model = [root.vendor, root.model]
      .map(x => (x || "").trim())
      .filter(Boolean)
      .join(" ");
    out.push({
      id: d.uuid || null,
      path: d.path || `/dev/${d.name}`,
      name: d.label || model || "USB disk",
      label: d.label || null,
      model: model || null,
      size: Number(d.size) || 0,
      fstype,
      fsName: FS_NAMES[fstype] || fstype,
      usable,
      reason
    });
  }
  return out;
}

let runImpl = runLsblk;

function runLsblk() {
  return getDappmanagerImage().then(
    image =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            `avado-backup-disks-${process.pid}-${Date.now() % 100000}`,
            "--privileged",
            "--network",
            "none",
            "--log-driver",
            "none",
            "-v",
            "/:/host",
            "--entrypoint",
            "chroot",
            image,
            "/host",
            "/bin/sh",
            "-c",
            // blkid probes the disks itself: lsblk alone reads the format and
            // label from udev, which may not know a disk yet
            `lsblk -J -b -o ${LSBLK_COLS}; echo '${BLKID_MARK}'; blkid -c /dev/null -o export 2>/dev/null; true`
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 1000);
        child.stdout.on("data", c => (out += c));
        child.stderr.on("data", c => (err += c));
        child.on("error", e => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", code => {
          clearTimeout(timer);
          if (code !== 0) return reject(Error(`lsblk failed (${code}): ${err.trim().slice(0, 200)}`));
          const [lsblk, blkid = ""] = out.split(BLKID_MARK);
          try {
            resolve(mergeBlkid(JSON.parse(lsblk), parseBlkid(blkid)));
          } catch (e) {
            reject(Error("lsblk gave no list"));
          }
        });
      })
  );
}

/** @returns {Promise<object[]>} see parseDisks */
async function listDisks() {
  return parseDisks(await runImpl());
}

module.exports = { listDisks, parseDisks, parseBlkid, mergeBlkid, _setRun: f => (runImpl = f || runLsblk) };
