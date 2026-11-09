import { Fragment } from "react";

// Keep interface wording in the interface language and mark only the quoted title.
export function TitledMessage({ message, title, lang }: { message: string; title: string; lang: string }) {
  return message.split("{title}").map((part, index) => <Fragment key={index}>{index > 0 && <span dir="auto" lang={lang}>{title}</span>}{part}</Fragment>);
}
