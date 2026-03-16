async function notify(result, config, logger) {
  logger.info("Notification placeholder executed.", {
    channel: config.notificationChannel,
    slotsFound: result.availableSlots.length,
  });
}

module.exports = {
  notify,
};
