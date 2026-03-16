function parseAppointments(pageContent, logger) {
  logger.debug("Parsing page content with placeholder parser.");

  return {
    availableSlots: [],
    rawContentLength: pageContent.length,
  };
}

module.exports = {
  parseAppointments,
};
