const crypto = require("crypto")
const fs = require("fs");
const path = require('path');
const logs = require("logs.js")(module);

const filePath = process.env.FILE_PATH;

/**
 * Create JWT token if it doesn't exist
 */
const createJWT = async () => {

    const fileName = path.join(filePath, "jwttoken.txt");

    let checkFileExists = s => new Promise(r => fs.access(s, fs.constants.F_OK, e => r(!e)))

    checkFileExists(fileName)
        .then(exists => {
            if (!exists) {
                logs.info("Generating JWT token");
                const jwttokenstring = crypto.randomBytes(32).toString("hex");
                fs.writeFileSync(fileName, jwttokenstring);
            } else {
                logs.info("JWT token already exists");
            }
        });
};

module.exports = createJWT;