// Keys for manual curriculum settings; no downloadable/importable subject packs.
export const stageRuleKeys = [
  "exam_sprint_before_grade",
  "insert_holiday_camp",
  "art_exam_end_after_school_exam",
  "art_transition_stage",
  "mock_exam_schedule",
];
export const manualSubjects = Object.fromEntries(
  ["music_interest", "music_exam", "art_interest", "art_exam"].map((key) => [
    key,
    { key },
  ]),
);
