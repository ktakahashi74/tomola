import { useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps } from "react";

// The server chooses the initial state. Native toggles, including ones made
// before hydration, own it afterwards; a newly requested opening still works.
export function PersistentDetails({ open = false, ref, onToggle, ...props }: ComponentProps<"details">) {
  const element = useRef<HTMLDetailsElement>(null);
  const [expanded, setExpanded] = useState(open);
  const requested = useRef(open);
  useImperativeHandle(ref, () => element.current!, []);
  useLayoutEffect(() => { setExpanded(element.current!.open); }, []);
  useLayoutEffect(() => {
    if (open && !requested.current) setExpanded(true);
    requested.current = open;
  }, [open]);
  return <details {...props} ref={element} open={expanded} suppressHydrationWarning onToggle={event => {
    setExpanded(event.currentTarget.open);
    onToggle?.(event);
  }} />;
}
