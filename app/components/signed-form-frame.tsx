import { createContext, useContext, useRef, useState, type ComponentProps, type ComponentType, type RefObject } from "react";
import { Form, useFormAction, useNavigation } from "react-router";
import { FormLanguageChangeContext, FormVillageReviewContext, type VillageReview } from "~/components/form-contexts";
import { Button } from "~/components/ui/button";
import type { UnsavedInitialValues } from "~/components/unsaved-form-guard";
import { m } from "~/paraglide/messages.js";

export type FormSubmitHandler = NonNullable<ComponentProps<typeof Form>["onSubmit"]>;
type SigningOptions = {
  signatureRequired: boolean;
  protectUnsaved?: "new" | "edit";
  unsavedInitialValues?: UnsavedInitialValues;
  preserveUnsavedOnSamePath?: boolean;
  confirmAiDraft?: boolean;
  signIntent?: string;
};
export type SignedFormProps = ComponentProps<typeof Form> & SigningOptions;
export type SignedFormControlsProps = SigningOptions & {
  action: ComponentProps<typeof Form>["action"];
  form: RefObject<HTMLFormElement | null>;
  bypass: RefObject<boolean>;
  review: RefObject<FormSubmitHandler | null>;
  setReady: (ready: boolean) => void;
};

const FormSendingContext = createContext<string | null>(null);

// The optional controls attach to the existing form, leaving native edits in place.
export function SignedFormFrame({ children, controls: Controls, signatureRequired, protectUnsaved, unsavedInitialValues, preserveUnsavedOnSamePath, confirmAiDraft, signIntent, onSubmit, onClickCapture, action, ...props }: SignedFormProps & {
  controls?: ComponentType<SignedFormControlsProps> | null;
}) {
  const [ready, setReady] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const bypass = useRef(false);
  const review = useRef<FormSubmitHandler | null>(null);
  const changeLanguage = useRef<((lang: string) => void) | null>(null);
  const reviewVillage = useRef<VillageReview | null>(null);
  const navigation = useNavigation();
  const formAction = useFormAction(action, { relative: props.relative });
  const sending = navigation.state !== "idle" && navigation.formData?.has("body") && navigation.formAction
    && new URL(navigation.formAction, window.location.href).pathname === new URL(formAction, window.location.href).pathname
    ? String(navigation.formData.get("intent") ?? "") : null;
  return <FormSendingContext.Provider value={sending}>
    <FormLanguageChangeContext.Provider value={changeLanguage}>
      <FormVillageReviewContext.Provider value={reviewVillage}>
        <Form {...props} action={action} data-ready={ready ? "true" : undefined} ref={form}
          onClickCapture={event => {
            onClickCapture?.(event);
            if (!event.defaultPrevented && (event.target as Element).closest("[data-discard-unsaved]")) {
              bypass.current = true;
              setTimeout(() => { bypass.current = false; }, 0);
            }
          }} onSubmit={event => {
            onSubmit?.(event);
            if (!event.defaultPrevented) review.current?.(event);
          }}>
          {children}
          {signatureRequired && <noscript><p role="note">{m.signing_no_js()}</p></noscript>}
        </Form>
        {Controls && <Controls {...{ form, bypass, review, setReady, action, signatureRequired, protectUnsaved, unsavedInitialValues, preserveUnsavedOnSamePath, confirmAiDraft, signIntent }} />}
      </FormVillageReviewContext.Provider>
    </FormLanguageChangeContext.Provider>
  </FormSendingContext.Provider>;
}

// A submit button that says "Sending…" while its form is in flight.
export function SendButton({ intent, children, disabled, ...props }: Omit<ComponentProps<typeof Button>, "name" | "value" | "type"> & { intent?: string }) {
  const sending = useContext(FormSendingContext);
  const mine = sending !== null && sending === (intent ?? "");
  return <Button {...props} type="submit" {...(intent ? { name: "intent", value: intent } : {})} disabled={disabled || sending !== null}>{mine ? m.form_sending() : children}</Button>;
}
