// Bound native build pools per server while keeping every isolated browser group.
export function browserServerEnvironment(environment, platform = process.platform) {
  const result = { ...environment };
  result.ROLLDOWN_WORKER_THREADS ||= "4";
  result.RAYON_NUM_THREADS ||= "4";
  if (platform === "linux") result.MALLOC_ARENA_MAX ||= "2";
  return result;
}
