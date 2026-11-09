export type ReadingInfo = {
  headings: Array<{ id: string; depth: 2 | 3; text: string }>;
  minutes: number;
};

export type ReadingVersions = {
  original: ReadingInfo;
  translation: ReadingInfo | null;
  older: ReadingInfo | null;
};
