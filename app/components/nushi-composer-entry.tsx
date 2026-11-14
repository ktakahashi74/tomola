import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

const Composer = lazy(() => import("./nushi-composer").then(module => ({ default: module.NushiComposerNotice })));

// A normal reading or writing page does not load the optional AI controls.
export function NushiComposerEntry({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), [active, setActive] = useState(false);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const inspect = () => setActive(/[@＠](?:nushi|village-ai)/iu.test(form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? ""));
    form.addEventListener("input", inspect); inspect();
    return () => form.removeEventListener("input", inspect);
  }, []);
  return <div ref={ref} className={active || children ? "basis-full" : undefined}>{active ? <Suspense fallback={children}><Composer>{children}</Composer></Suspense> : children}</div>;
}
