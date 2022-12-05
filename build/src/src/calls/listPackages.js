const fs = require("fs");
const params = require("params");
const logs = require("logs.js")(module);
// Modules
const dockerList = require("modules/dockerList");
const docker = require("modules/docker");
// Utils
const parseDockerSystemDf = require("utils/parseDockerSystemDf");
const getPath = require("utils/getPath");
const envsHelper = require("utils/envsHelper");
const db = require("../db");

// This call can fail because of:
//   Error response from daemon: a disk usage operation is already running
// Prevent running it twice
let isRunning;
let cacheResult;
async function dockerSystemDf() {
    if (isRunning && cacheResult) return cacheResult;
    isRunning = true;
    cacheResult = await docker.systemDf();
    isRunning = false;
    return cacheResult;
}

/**
 * Returns the list of current containers associated to packages
 *
 * @returns {array} dnpInstalled = [{
 *   id: "923852...", {string}
 *   packageName: "DAppNodePackage-admin...", {string}
 *   version: "0.1.8", {string}
 *   isDNP: true, {bool}
 *   isCORE: false, {bool}
 *   created: <data string>, {string}
 *   image: "admin.dnp.dappnode.eth-0.1.8", {string}
 *   name: "admin.dnp.dappnode.eth", {string}
 *   shortName: "admin", {string}
 *   ports: [{
 *     PrivatePort: 2222, {number}
 *     PublicPort: 3333, {number}
 *     Type: "tcp" {string}
 *   }, ... ], {array}
 *   volumes: [{
 *     type: "bind", {string}
 *     name: "admin_data", {string}
 *     path: "source path" {string}
 *   }, ... ] {array}
 *   state: "running", {string}
 *   running: true, {bool}
 *
 *   // From labels
 *   origin: "/ipfs/Qmabcd...", {string}
 *   chain: "ethereum", {string}
 *   dependencies: { dependency.dnp.dappnode.eth: "0.1.8" }, {object}
 *   portsToClose: [ {number: 30303, type: 'UDP'}, ...], {array}
 *
 *   // Appended here
 *   envs: { ENV_NAME: "ENV_VALUE" }, {object}
 *   manifest: <manifest object> {object}
 * }, ... ]
 */
const listPackages = async () => {
    let dnpList = await dockerList.listContainers();

    // Append volume info
    // This call can fail because of:
    //   Error response from daemon: a disk usage operation is already running
    try {
        const dockerSystemDfData = await dockerSystemDf();
        dnpList = parseDockerSystemDf({ data: dockerSystemDfData, dnpList });
    } catch (e) {
        logs.error(`Error on listPackages, appending volume info: ${e.stack}`);
    }

    // Append envFile and manifest
    dnpList = await Promise.all(dnpList.map(async dnp => {
        // Add env info, only if there are ENVs
        try {
            const envs = envsHelper.load(dnp.name, dnp.isCore);
            if (Object.keys(envs).length) dnp.envs = envs;
        } catch (e) {
            logs.warn(`Error appending ${(dnp || {}).name} envs: ${e.stack}`);
        }

        // Add manifest
        try {
            const manifestPath = getPath.manifest(dnp.name, params, dnp.isCore);
            if (fs.existsSync(manifestPath)) {
                const manifestFileData = fs.readFileSync(manifestPath, "utf8");
                try {
                    dnp.manifest = JSON.parse(manifestFileData);
                } catch (e) {
                    // Silence parsing errors
                }
            }
        } catch (e) {
            logs.warn(`Error appending ${(dnp || {}).name} manifest: ${e.message}`);
        }

        try {
            // Add autoupdate
            const dbKey = `autoupdate-${dnp.name.replace(/\./g, "_")}`;
            const autoUpdateDB = await db.get(dbKey);
            // const autoUpdateDefault = dnp && dnp.manifest && dnp.manifest.autoupdate === true;
            // Autoupdate is default TRUE unless defined
            // This forces core packages to auto-update
            const autoUpdateDefault = true;
            const autoUpdate = autoUpdateDB === undefined ? autoUpdateDefault : autoUpdateDB;
            if (dnp && !dnp.manifest) {
                dnp.manifest = {};  // installed CORE packages have no manifest
            }
            dnp.manifest.autoupdate = autoUpdate;
        } catch (e) {
            logs.warn(`Error appending ${(dnp || {}).name} autoupdate: ${e.message}`);
        }

        return dnp;
    }));

    console.log(`DNPs fetched`);
    dnpList && dnpList.map((d)=>{
        console.log(`${d.name} - autoupdate ${d.manifest.autoupdate}`)
    });

    return {
        message: `Listing ${dnpList.length} packages`,
        result: dnpList
    };
};

module.exports = listPackages;