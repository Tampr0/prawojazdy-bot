const { logInfo } = require("./logger");

async function notify(message) {
  logInfo(`Powiadomienie mock: ${message}`);
}

module.exports = {
  notify,
};
