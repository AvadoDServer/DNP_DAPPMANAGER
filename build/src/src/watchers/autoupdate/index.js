"use strict";

// const params = require("../../params");
const calls = require("../../calls");
const ipfs = require("../../modules/ipfs");
const semver = require('semver');
const db = require("../../db");
const logs = require("logs.js")(module);
const jayson = require('jayson');


const rpcClient = new jayson.client.https({
    host: "rpc.ava.do"
});

const findLatestVersion = (store, packagename) => {
    if (!store || !store.packages) {
        return null;
    }
    const latestPackage = store.packages.find((p) => { return p.manifest.name === packagename });
    return latestPackage ? { hash: latestPackage.manifesthash, manifest: latestPackage.manifest } : null;
};

const monitorUpdates = async () => {
    // get list of packages
    logs.info(`fetching installed packages`);
    const packageList = await calls.listPackages().then((res) => { return res.result });

    // compile request to get package updates from the store
    const i = {
        packages: packageList.map((i) => { return { name: i.name, version: i.version } }),
        nodeid: await db.get("address"),
    };
    // logs.info(`installed packages ${JSON.stringify(i, null, 2)}`);

    // fetch updated packages from the store
    rpcClient.request('store.getUpdates', i, async (err, response) => {
        if (err) {
            logs.info(`store.getUpdates returned error ${err.message}`);
        }

        if (response && response.result) {
            // get the store hash & download the the store from IPFS
            const hash = JSON.parse(response.result).hash;
            const store = await ipfs.cat(hash).then(JSON.parse);

            // get list of packages to upgrade
            const upgrades = await Promise.all(packageList.map(async (installedPackage) => {
                const dbKey = `autoupdate-${installedPackage.name.replace(/\./g, "_")}`;
                const autoUpdateDB = await db.get(dbKey);
                const autoUpdate = autoUpdateDB === undefined ? installedPackage.manifest.autoupdate || true : autoUpdateDB;
                if (autoUpdate === true) {
                    // logs.info(`${installedPackage.name} has autoupdates on`);
                    const latestVersion = findLatestVersion(store, installedPackage.name);
                    // logs.info(`latestVersion of ${installedPackage.name} is ${JSON.stringify(latestVersion, null, 2)}`);
                    if (latestVersion && semver.gt(latestVersion.manifest.version, installedPackage.version)) {
                        logs.info(`package ${installedPackage.name} requires an update from ${installedPackage.version} -> ${latestVersion.manifest.version}`);
                        return (`${installedPackage.name}@${latestVersion.hash}`);
                    } else {
                        logs.info(`no update for package ${installedPackage.name}. local=${installedPackage ? installedPackage.version : "unknown"}, store=${latestVersion ? latestVersion.manifest.version : "unknown"}`);
                    }
                } else {
                    logs.info(`auto update disabled for package ${installedPackage.name}`);
                }
                return null;
            }));

            // remove packages that need no update
            const toUpgrade = upgrades.reduce((accum, item) => {
                item && accum.push(item);
                return accum;
            }, []);

            // pick random item & only update that one in this run
            if (toUpgrade.length > 0) {
                logs.info(`packages to upgrade ${JSON.stringify(toUpgrade, null, 2)}`);
                var item = toUpgrade[Math.floor(Math.random() * toUpgrade.length)];
                logs.info(`package selected for update: update package ${item}`);
                calls.installPackage({ id: item }).then(() => { logs.info(`installed package ${item}`) });
            }

        } else {
            logs.info(`store.getUpdates returned empty result`);
        }
    });
};
logs.info(`starting auto-updater`);
const monitoringInterval = 60 * 60 * 1000; // (ms) (1 hour)
monitorUpdates();
setInterval(() => {
    logs.info(`running auto-updater`);
    monitorUpdates();
}, monitoringInterval);

module.exports = monitorUpdates;

