/**
 * stop_grace_period, mem_limit (also from deploy.resources) and devices
 */
const name = "stop_grace_period, memory limit and devices";

const manifest = {
  name: "bitcoincore.avado.dnp.dappnode.eth",
  version: "0.2.0",
  image: {
    volumes: ["bitcoincore:/data"],
    restart: "always",
    stop_grace_period: "10m",
    deploy: { resources: { limits: { memory: "8g" } } },
    devices: ["/dev/dri", "/dev/ttyUSB0:/dev/zigbee", "/dev/sda", "/dev/kfd:/dev/kfd:rw"]
  }
};

const dc = `version: '3.4'
services:
    bitcoincore.avado.dnp.dappnode.eth:
        container_name: DAppNodePackage-bitcoincore.avado.dnp.dappnode.eth
        image: 'bitcoincore.avado.dnp.dappnode.eth:0.2.0'
        restart: always
        volumes:
            - 'bitcoincore:/data'
        networks:
            - dncore_network
        dns: 172.33.1.2
        stop_grace_period: 600s
        mem_limit: 8589934592
        devices:
            - '/dev/dri:/dev/dri:rwm'
            - '/dev/ttyUSB0:/dev/zigbee:rwm'
            - '/dev/kfd:/dev/kfd:rw'
        logging:
            options:
                max-size: 10m
                max-file: '3'
volumes:
    bitcoincore: {}
networks:
    dncore_network:
        external: true
`;

module.exports = { name, manifest, dc };
