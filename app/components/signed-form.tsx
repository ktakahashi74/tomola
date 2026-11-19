import SignedFormControls from "~/components/signed-form-controls";
import { SignedFormFrame, type SignedFormProps } from "~/components/signed-form-frame";

export { SendButton } from "~/components/signed-form-frame";
export { SigningChanges } from "~/components/signed-form-controls";

export function SignedForm(props: SignedFormProps) {
  return <SignedFormFrame {...props} controls={SignedFormControls} />;
}
