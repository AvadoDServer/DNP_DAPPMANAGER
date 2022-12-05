#!/bin/bash

# This script can install updates on the Avado host system.
#
# We do this by first adding this script to /etc/rc.local and rebooting.
# This way this scripts really runs on the host without using docker sockets.

# Wait for any other dpkg process holding the lock
lock_wait () {
  while lsof /var/lib/dpkg/lock >/dev/null 2>&1 ; do
    sleep 1
  done
  while lsof /var/lib/apt/lists/lock >/dev/null 2>&1 ; do
    sleep 1
  done
  if [ -f /var/log/unattended-upgrades/unattended-upgrades.log ]; then
    while lsof /var/log/unattended-upgrades/unattended-upgrades.log >/dev/null 2>&1 ; do
      sleep 1
    done
  fi
}

LOGFILE=/root/update/log.txt
date | tee -a ${LOGFILE}
echo "Start upgrade script" | tee -a ${LOGFILE}

# Am I in RC.local already?
if [ ! -f /etc/rc.local ]; then
    echo "#!/bin/sh -e" >>/etc/rc.local
    echo "exit 0" >>/etc/rc.local
    chmod +x /etc/rc.local
    systemctl start rc-local
fi
if ! grep -q "update-0001.sh" "/etc/rc.local"; then
    echo "Adding myself to /etc/rc.local" | tee -a ${LOGFILE}
    # move this script out of the way so it does not get overwritten
    cp -p /root/update/updateAvadoHost.sh /root/update/update-0001.sh
    # add the copy of the script to rc.local
    sed -i '$i/root/update/update-0001.sh' /etc/rc.local
    # If geth is running, give it enough time to cleanly shut down
    docker stop DAppNodePackage-ethchain-geth.public.dappnode.eth -t 180
    # and finally: reboot
    reboot
    exit
fi

# We have now rebooted and are running on the host

# Check Docker update
DOCKER_VERSION=$(docker --version | sed -n "s/Docker version \([0-9\.]*\),.*/\1/p")
DEBIAN_CODENAME=$(lsb_release -c | cut -d ":" -f 2 | xargs) # buster or bullseye

echo -n "Check Docker update: " | tee -a ${LOGFILE}
lock_wait
if dpkg --compare-versions "${DOCKER_VERSION}" "lt" "20.10.17"; then
    echo "current docker version: ${DOCKER_VERSION}" | tee -a ${LOGFILE}
    echo "Update required. Updating" | tee -a ${LOGFILE}
    pushd /root/update/${DEBIAN_CODENAME}
    # update docker by installing new packages
    for pack in containerd.io_*.deb docker-ce_*.deb docker-ce-cli_*.deb; do #sequence is important
        echo "--> Installing ${pack}" | tee -a ${LOGFILE}
        lock_wait
        dpkg -i ${pack} 2>&1 | tee -a ${LOGFILE}
        echo "--> Configuring"
        lock_wait
        dpkg --configure -a 2>&1 | tee -a ${LOGFILE}
    done
    popd
    echo "--> Update finished." | tee -a ${LOGFILE}
    sleep 5
    # Check Docker version after update
    DOCKER_VERSION=$(docker --version | sed -n "s/Docker version \([0-9\.]*\),.*/\1/p")
    echo "Docker version after update: ${DOCKER_VERSION}"
    lock_wait
    if dpkg --compare-versions "${DOCKER_VERSION}" "lt" "20.10.17"; then
        echo "Update failed." | tee -a ${LOGFILE}
    else
        # on successful update - reboot node once again
        echo "Update succeeded." | tee -a ${LOGFILE}
        dpkg --configure -a 2>&1 | tee -a ${LOGFILE}
        reboot
    fi
else
    dpkg --configure -a 2>&1 | tee -a ${LOGFILE}
    echo "OK" | tee -a ${LOGFILE}
fi