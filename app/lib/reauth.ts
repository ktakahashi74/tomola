// Address of the login screen that re-verifies a signed-in member by email and
// then returns to `next`. Callers supply a local path; the login loader
// validates it again before redirecting.
export function reauthenticationPath(next: string): string {
  return `/login?${new URLSearchParams({ reauth: "1", next })}`;
}
