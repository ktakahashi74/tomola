// Observation constants (observation.server.ts), shared by server/browser and shown in UI explanations.

// Number of months shown/exported, including current month.
export const OBSERVATION_MONTHS = 12;
// Minimum monthly posts to show diversity; fewer samples have unstable averages, so omit them.
export const MIN_DIVERSITY_ENTRIES = 5;
// 「同調の兆し」 warning after this many declines in consecutive months: four completed-month values decrease three times. Exclude current month,
// and require the sequence to end at the latest completed month.
export const CONFORMITY_DECLINES = 3;
