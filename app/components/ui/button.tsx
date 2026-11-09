import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { Check } from "lucide-react"
import { cn } from "~/lib/utils"

// Which button to use.
// - default (filled ink): the one main action of a screen. Never more than one on a screen (the one that saves, sends or posts).
// - outline: an ordinary action, and a toggle whose state is not chosen yet.
// - ghost / link: a quiet or in-text action.
// - pressed: a toggle (Insightful, a stance, follow, the way of editing). Pass pressed={true|false}; the chosen state gets a light ground, an ink border and a check mark, and aria-pressed is set.
//   marked: the same look without the toggle meaning, for a button whose label is an action ("Revoke") that is shown on the state it acts on.
//   Choosing a place (order, filter, tab, side column) is not a toggle: use the "choice" class in app/app.css.
// - pending: the form this button sends is in flight (pass fetcher.state !== "idle"). One look for every screen: the label goes pale and the button stops taking presses, but it keeps the keyboard focus
//   and says aria-busy. Do not hide the button or swap its label for a spinner.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none data-pressed:border-foreground data-pressed:bg-selected data-pressed:text-selected-foreground data-pressed:hover:bg-selected data-pressed:no-underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground ",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground ",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 ",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  pressed,
  marked,
  pending,
  children,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { pressed?: boolean; marked?: boolean; pending?: boolean }) {
  const chosen = pressed === true || marked === true
  return (
    <ButtonPrimitive
      data-slot="button"
      data-pressed={chosen ? "" : undefined}
      data-pending={pending ? "" : undefined}
      aria-pressed={pressed}
      aria-busy={pending ? true : undefined}
      aria-disabled={pending ? true : undefined}
      className={cn(buttonVariants({ variant, size, className }), "data-pending:pointer-events-none data-pending:opacity-50")}
      {...props}
    >
      {chosen ? <Check aria-hidden="true" data-icon="inline-start" /> : null}
      {children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
