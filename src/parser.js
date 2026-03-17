function parseScheduleResponse(responseData) {
  const scheduledDays = responseData?.schedule?.scheduledDays || [];
  const slots = [];

  for (const scheduledDay of scheduledDays) {
    const scheduledHours = scheduledDay?.scheduledHours || [];

    for (const scheduledHour of scheduledHours) {
      const practiceExams = scheduledHour?.practiceExams || [];

      for (const exam of practiceExams) {
        slots.push({
          id: exam?.id ?? null,
          date: scheduledDay?.date || null,
          places: exam?.places ?? null,
          amount: exam?.amount ?? null,
          additionalInfo: exam?.additionalInfo ?? null,
          day: scheduledDay?.day || null,
          time: scheduledHour?.time || null,
        });
      }
    }
  }

  return slots;
}

module.exports = {
  parseScheduleResponse,
};
