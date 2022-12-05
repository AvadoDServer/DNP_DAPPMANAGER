// node modules
const shell = require("./shell");
const dockerCommands = require("./dockerCommands");
const { mapValues } = require("lodash");

const logs = require("logs.js")(module);

// show list of docker commands
// function iterate(obj) {
//   for (var property in obj) {
//       if (obj.hasOwnProperty(property)) {
//           if (typeof obj[property] == "object") {
//               iterate(obj[property]);
//           }
//           else {
//             logs.info(`property ${property} type ${typeof obj[property]}`)
//           }
//       }
//   }
// }
// logs.info(`dockercommands`)
// iterate(dockerCommands);

/**
 * Wraps the docker command getters with the shell utility.
 * function up(id) {
 *   return `docker-compose up ${id}`
 * }
 * const docker = wrapCommands({ up })
 * docker = {
 *   up: (id) => shell(up(id))
 * }
 *
 * It does so recursively, because the commands are organized at
 * more than 1 level deep
 * @param {object} obj
 */
function wrapCommands(obj) {
  return mapValues(obj, commandGetter => {
    if (typeof commandGetter === "object") return wrapCommands(commandGetter);
    else
      return function(...args) {
        return shell(commandGetter(...args));
      };
  });
}

module.exports = wrapCommands(dockerCommands);
