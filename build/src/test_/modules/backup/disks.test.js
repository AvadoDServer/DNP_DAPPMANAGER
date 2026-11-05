const expect = require("chai").expect;
const { parseDisks } = require("modules/backup/disks");

// lsblk -J -b -o NAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,TRAN,HOTPLUG,RM,MODEL,VENDOR,PKNAME
// on the test box (util-linux 2.36) with a USB stick and a test loop file
const box = {
  blockdevices: [
    { name: "loop0", path: "/dev/loop0", type: "loop", size: 2147483648, fstype: "ext4", label: "AVADO-BACKUP", uuid: "1111-loop", mountpoint: null, tran: null, hotplug: false, rm: false, model: null, vendor: null, pkname: null },
    { name: "loop1", path: "/dev/loop1", type: "loop", size: 1000, fstype: "squashfs", label: null, uuid: null, mountpoint: "/snap/x", tran: null, hotplug: false, rm: false, model: null, vendor: null, pkname: null },
    {
      name: "sda", path: "/dev/sda", type: "disk", size: 64023257088, fstype: null, label: null, uuid: null, mountpoint: null, tran: "usb", hotplug: true, rm: true, model: "Ultra Fit", vendor: "SanDisk ", pkname: null,
      children: [{ name: "sda1", path: "/dev/sda1", type: "part", size: 64022208512, fstype: "exfat", label: "STICK", uuid: "64B2-1A2F", mountpoint: null, tran: null, hotplug: true, rm: true, model: null, vendor: null, pkname: "sda" }]
    },
    {
      name: "sdb", path: "/dev/sdb", type: "disk", size: 1000, fstype: null, label: null, uuid: null, mountpoint: null, tran: "usb", hotplug: "1", rm: "0", model: "Disk", vendor: null, pkname: null,
      children: [{ name: "sdb1", path: "/dev/sdb1", type: "part", size: 1000, fstype: "hfsplus", label: "Mac", uuid: "abcd", mountpoint: null, tran: null, hotplug: "1", rm: "0", model: null, vendor: null, pkname: "sdb" }]
    },
    {
      name: "nvme0n1", path: "/dev/nvme0n1", type: "disk", size: 4000787030016, fstype: null, label: null, uuid: null, mountpoint: null, tran: "nvme", hotplug: false, rm: false, model: "Samsung", vendor: null, pkname: null,
      children: [
        { name: "nvme0n1p1", path: "/dev/nvme0n1p1", type: "part", size: 536870912, fstype: "vfat", label: "AVADO-EFI", uuid: "EF12", mountpoint: "/boot/efi", pkname: "nvme0n1" },
        { name: "nvme0n1p3", path: "/dev/nvme0n1p3", type: "part", size: 4000000000000, fstype: "LVM2_member", uuid: "lvm", mountpoint: null, pkname: "nvme0n1",
          children: [{ name: "rootvg-root", path: "/dev/mapper/rootvg-root", type: "lvm", size: 4000000000000, fstype: "ext4", uuid: "root", mountpoint: "/", pkname: "nvme0n1p3" }] }
      ]
    },
    {
      name: "sdc", path: "/dev/sdc", type: "disk", size: 2000, fstype: null, tran: "usb", hotplug: true, rm: false, model: "USB boot", pkname: null,
      children: [{ name: "sdc1", path: "/dev/sdc1", type: "part", size: 2000, fstype: "ext4", uuid: "usbroot", mountpoint: "/", pkname: "sdc" }]
    }
  ]
};

describe("modules > backup > disks", () => {
  const list = parseDisks(box);
  it("offers USB disks and AVADO-labelled disks", () => {
    expect(list.map(d => d.path)).to.deep.equal(["/dev/loop0", "/dev/sda1", "/dev/sdb1"]);
    const stick = list.find(d => d.path === "/dev/sda1");
    expect(stick).to.include({ id: "64B2-1A2F", name: "STICK", fsName: "exFAT", usable: true, model: "SanDisk Ultra Fit" });
  });
  it("never offers the box's own disk, even when labelled AVADO", () => {
    expect(list.find(d => /nvme|mapper/.test(d.path))).to.equal(undefined);
  });
  it("never offers a USB disk the system runs from", () => {
    expect(list.find(d => d.path === "/dev/sdc1")).to.equal(undefined);
  });
  it("says why a disk can't be used", () => {
    const mac = list.find(d => d.path === "/dev/sdb1");
    expect(mac.usable).to.equal(false);
    expect(mac.reason).to.match(/exFAT, NTFS or ext4/);
  });
});

describe("modules > backup > disks: blkid fills what udev did not know", () => {
  const { parseBlkid, mergeBlkid, parseDisks: parse } = require("modules/backup/disks");
  it("merges format, label and id by device", () => {
    const by = parseBlkid("DEVNAME=/dev/loop0\nLABEL=AVADO-BACKUP\nUUID=9f1c\nBLOCK_SIZE=4096\nTYPE=ext4\n\nDEVNAME=/dev/sda1\nUUID=64B2\nTYPE=exfat\n");
    const j = mergeBlkid({ blockdevices: [{ name: "loop0", path: "/dev/loop0", type: "loop", size: 1, fstype: null, label: null, uuid: null }] }, by);
    expect(parse(j)).to.have.length(1);
    expect(parse(j)[0]).to.include({ id: "9f1c", label: "AVADO-BACKUP", fstype: "ext4", usable: true });
  });
});
