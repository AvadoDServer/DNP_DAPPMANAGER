#!/bin/sh

# copy script to update docker to the host system
docker run --rm --privileged  --net=host --pid=host --ipc=host --volume /:/host  busybox  chroot /host docker cp DAppNodeCore-dappmanager.dnp.dappnode.eth:/update/ /root
docker run --rm --privileged  --net=host --pid=host --ipc=host --volume /:/host  busybox  chroot /host sh -c "/root/update/updateAvadoHost.sh"


# main part
crond
echo "File folder at ${FILE_PATH}"
mkdir -p ${FILE_PATH}
NODE_PATH=src node src/index.js


