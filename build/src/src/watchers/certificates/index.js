"use strict";
const logs = require("logs.js")(module);
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const filePath = process.env.FILE_PATH;

const checkCert = (filename, crt_pem) => {
    const cert = new crypto.X509Certificate(crt_pem);
    const notAfter = cert.validTo;
    const diff = (new Date(notAfter)) - Date.now();
    if (diff > 24 * 60 * 60 * 1000) {
        logs.info(`Certificate ${filename} valid until ${notAfter}`);
        return true;
    } else if (diff > 0) {
        logs.info(`ERROR - certificate ${filename} valid less than 24 hours! Valid until ${notAfter}`);
        return false;
    } else {
        logs.info(`ERROR - certificate ${filename} has expired ! Valid until ${notAfter}`);
        return false;
    }
}

const monitorUpdates = async () => {

    const files = [
        { url: "http://iso.ava.do/my.ava.do.crt", filename: path.join(filePath, 'my.ava.do.crt'), verify: checkCert },
        { url: "http://iso.ava.do/my.ava.do.key", filename: path.join(filePath, 'my.ava.do.key'), }
    ]

    Promise.all(files.map((f) => {
        logs.info(`Downloading ${f.url}`);
        return axios.get(f.url)
            .then(response => {
                // do we need to verify this data ?
                if (f.verify && !f.verify(path.basename(f.filename), response.data)) {
                    throw new Error(`Certificate ${path.basename(f.filename)} is invalid`);
                } else {
                    return new Promise((resolve, reject) => {
                        fs.writeFile(`${f.filename}.tmp`, response.data, err => {
                            if (err) {
                                return reject(err);
                            }
                            logs.info(`File ${path.basename(f.filename)} saved successfully!`);
                            return resolve(f.filename);
                        });
                    })
                }
            }).catch((e) => {
                logs.info(`ERROR downloading ${f.url}: ${e.message}`);
                throw new Error(e);
            })
    })).then((files) => {
        // logs.info(`files fetched: `, files);
        files.map((file) => {
            logs.info(`replacing file ${path.basename(file)}`)
            fs.renameSync(`${file}.tmp`, file);
        });
        logs.info(`Certificates successfully fetched & updated.`)
    }).catch((e) => {
        logs.info(`Error downloading certificates ${e.message}`);
    });



};

logs.info(`starting Certificate fetcher`);
const monitoringInterval = 1 * 24 * 60 * 60 * 1000; // (ms) (1 day)
monitorUpdates();
setInterval(() => {
    logs.info(`running Certificate fetcher`);
    monitorUpdates();
}, monitoringInterval);

module.exports = monitorUpdates;

