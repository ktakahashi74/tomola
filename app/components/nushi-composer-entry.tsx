import { lazy, Suspense, useEffect, useRef, useState } from "react";

const Composer = lazy(() => import("./nushi-composer").then(module => ({ default: module.NushiComposerNotice })));

// A normal reading or writing page does not load the optional AI controls.
export function NushiComposerEntry() {
  const ref = useRef<HTMLDivElement>(null), [active, setActive] = useState(false);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const inspect = () => setActive(/[@＠](?:nushi|village-ai)/iu.test(form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? ""));
    form.addEventListener("input", inspect); inspect();
    return () => form.removeEventListener("input", inspect);
  }, []);
  return <div ref={ref} className={active ? "basis-full" : undefined}>{active && <Suspense fallback={null}><Composer /></Suspense>}</div>;
}
