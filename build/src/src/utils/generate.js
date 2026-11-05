const yaml = require("js-yaml");
const composeLimits = require("./composeLimits");

/*
 * Generates files needed by DNPs
 * - dockerCompose
 * - manifest
 */

/**
 * @param {object} manifest
 * @param {object} params
 * @param {object} [options]
 * @param {string[]} [options.presentDevices] host devices that exist (see
 *   composeLimits.devices); when left out every allowed device is kept
 * @param {function} [options.onNote] gets one sentence per manifest value
 *   that was clamped or left out
 */
function dockerCompose(manifest, params, options = {}) {
    // Define docker compose parameters
    const DNS_SERVICE = params.DNS_SERVICE;
    const DNP_NETWORK = params.DNP_NETWORK;
    const CONTAINER_NAME_PREFIX = params.CONTAINER_NAME_PREFIX;
    const CONTAINER_CORE_NAME_PREFIX = params.CONTAINER_CORE_NAME_PREFIX;

    const PACKAGE_NAME = manifest.name.replace("/", "_").replace("@", "");

    // Assume not allowed core condition is already verified
    const isCore = manifest.type === "dncore";

    // DOCKER COMPOSE YML - SERVICE
    // ============================
    let service = {};
    if (isCore) {
        service.container_name = CONTAINER_CORE_NAME_PREFIX + PACKAGE_NAME;
    } else {
        service.container_name = CONTAINER_NAME_PREFIX + PACKAGE_NAME;
    }

    if (manifest.image.privileged) {
        service.privileged = true;
    }
    // Image name
    service.image = manifest.name + ":" + manifest.version;
    if (manifest.image.restart) {
        service.restart = manifest.image.restart;
    }

    // Volumes
    service.volumes = [
        ...(manifest.image.volumes || []),
        ...(manifest.image.external_vol || [])
    ];

    // Ports
    if (manifest.image.ports) {
        service.ports = manifest.image.ports;
    }

    // Support for environment variables
    if (manifest.image.environment) {
        service.env_file = [PACKAGE_NAME + ".env"];
    }

    // Networks
    //   if (isCore) {
    if (manifest.image.ipv4_address) {
        service.networks = {
            network: {
                ipv4_address: manifest.image.ipv4_address
            }
        };
        // }
    } else {
        service.networks = [DNP_NETWORK];
    }

    // DNS
    service.dns = DNS_SERVICE;

    // label handling
    // Append existing labels
    if (manifest.image.labels) {
        // Correct labels as array to be an object
        if (Array.isArray(manifest.image.labels)) {
            let _obj = {};
            manifest.image.labels.forEach(e => {
                if (typeof e === "string") {
                    let [key, value] = e.split("=");
                    _obj[key] = value || "";
                }
            });
            manifest.image.labels = _obj;
        }
        // Merge labels:
        // service.labels = {
        //   label: "value",
        //   label-without-value: "" }
        service.labels = {
            ...(service.labels || {}),
            ...manifest.image.labels
        };
    }
    // Add the dependencies of the package in its labels
    // This will help the resolver not need to access IPFS (and ENS)
    // to know its dependencies
    if (manifest.dependencies) {
        service.labels = {
            ...(service.labels || {}),
            "dappnode.dnp.dependencies": JSON.stringify(manifest.dependencies)
        };
    }
    // Adding the origin of the package as a label to be used in the resolve
    // This is important to recognize if this package comes from IPFS or ENS
    // origin is critical for dappGet/aggregate on IPFS DNPs
    if (manifest.origin) {
        service.labels = {
            ...(service.labels || {}),
            "dappnode.dnp.origin": manifest.origin
        };
    }
    // Add the chain driver
    // This will automatically trigger the chain watcher
    if (manifest.chain) {
        service.labels = {
            ...(service.labels || {}),
            "dappnode.dnp.chain": manifest.chain
        };
    }

    // Extra features
    if (manifest.image.cap_add) service.cap_add = manifest.image.cap_add;
    if (manifest.image.cap_drop) service.cap_drop = manifest.image.cap_drop;
    if (manifest.image.network_mode)
        service.network_mode = manifest.image.network_mode;
    if (manifest.image.command) service.command = manifest.image.command;

    // Stop time, memory limit and host devices, each checked against caps
    // first (utils/composeLimits). A value that fails the check is clamped
    // or left out and reported through options.onNote; never an error.
    const notes = [];
    const grace = composeLimits.stopGracePeriod(manifest.image);
    if (grace.value) service.stop_grace_period = grace.value;
    if (grace.note) notes.push(grace.note);
    const mem = composeLimits.memoryLimit(manifest.image);
    if (mem.bytes) service.mem_limit = mem.bytes;
    if (mem.note) notes.push(mem.note);
    if (manifest.image.devices !== undefined) {
        const dev = composeLimits.devices(manifest.image, options.presentDevices);
        if (dev.devices.length) service.devices = dev.devices;
        notes.push(...dev.notes);
    }
    if (notes.length && typeof options.onNote === "function") {
        for (const note of notes) options.onNote(note);
    }

    // Logging. Limit logs size, chains can grow the logs to > 20 GB
    // "json-file" is the default driver
    // https://docs.docker.com/config/containers/logging/configure/#configure-the-default-logging-driver
    service.logging = {
        options: {
            "max-size": "10m",
            "max-file": "3"
        }
    };

    // DOCKER COMPOSE YML - VOLUMES
    // ============================
    let volumes = {};
    // Regular volumes
    if (manifest.image.volumes) {
        manifest.image.volumes.forEach(vol => {
            // Make sure it's a named volume
            if (!vol.startsWith("/") && !vol.startsWith("~")) {
                const volName = vol.split(":")[0];
                volumes[volName] = {};
            }
        });
    }
    // External volumes
    if (manifest.image.external_vol) {
        manifest.image.external_vol.forEach(vol => {
            const volName = vol.split(":")[0];
            volumes[volName] = {
                external: {
                    name: volName
                }
            };
        });
    }

    // DOCKER COMPOSE YML - NETWORKS
    // ============================
    let networks = {};
    if (manifest.image.subnet) {
        networks = {
            network: {
                driver: "bridge",
                ipam: {
                    config: [{ subnet: manifest.image.subnet }]
                }
            }
        };
    } else {
        networks[DNP_NETWORK] = {
            external: true
        };
    }

    let dockerCompose = {
        version: "3.4",
        services: {
            [PACKAGE_NAME]: service
        }
    };
    if (Object.getOwnPropertyNames(volumes).length)
        dockerCompose.volumes = volumes;
    if (Object.getOwnPropertyNames(networks).length)
        dockerCompose.networks = networks;

    const dump =  yaml.dump(dockerCompose, {
        indent: 4
    });

    // console.log("created docker-compose");
    // console.log(dump);

    return dump;
}

function manifest(dnpManifest) {
    return JSON.stringify(dnpManifest, null, 2);
}

module.exports = {
    dockerCompose,
    manifest
};
