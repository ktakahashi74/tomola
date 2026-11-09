import type { ComponentProps } from "react";
import { EntryEditForm as EditForm } from "~/components/entry-edit-form";
import { MediaInsert, MediaInsertHelp } from "~/components/media-insert";

// Keep the upload entry point in topic editors, outside the shared reply editor bundle.
export function TopicEntryEditForm(props: ComponentProps<typeof EditForm>) {
  return <EditForm {...props} bodyAccessory={<MediaInsert key={props.baseSourceHash} compact />} writingHelp={<MediaInsertHelp />} />;
}
