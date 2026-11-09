type ReadingPosition = { id: string; top: number; seq: number };
const positions = new Map<string, ReadingPosition | undefined>();

export const hasChatReadingPosition = (key: string) => positions.has(key);
export const getChatReadingPosition = (key: string) => positions.get(key);
export function rememberChatReadingPosition(key: string, position?: ReadingPosition) {
  const value = position ?? positions.get(key);
  positions.delete(key);
  positions.set(key, value);
  if (positions.size > 50) positions.delete(positions.keys().next().value!);
}
