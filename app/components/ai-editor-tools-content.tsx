import { useState } from "react";
import { AiWrite } from "~/components/ai-write";
import type { AiEditorToolsProps } from "~/components/ai-editor-tools";

// Writing with an AI is one entry: the button opens a panel that holds both asking an AI and pasting its text back.
export default function AiEditorToolsContent({ candidate, onCandidateChange, ...props }: AiEditorToolsProps) {
  const [own, setOwn] = useState("");
  return <AiWrite {...props} candidate={candidate ?? own} onCandidateChange={onCandidateChange ?? setOwn} />;
}
