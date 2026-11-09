import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Editor, commandsCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkStringifyOptionsCtx, rootCtx, serializerCtx, parserCtx } from "@milkdown/kit/core";
import { commonmark, imageSchema, orderedListSchema, wrapInOrderedListInputRule, toggleStrongCommand, toggleEmphasisCommand, wrapInHeadingCommand, wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInOrderedListCommand } from "@milkdown/kit/preset/commonmark";
import { gfm, remarkGFMPlugin, strikethroughInputRule, strikethroughSchema, insertTableCommand, addRowAfterCommand, addColAfterCommand, selectRowCommand, selectColCommand, deleteSelectedCellsCommand } from "@milkdown/kit/preset/gfm";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history, undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import { NodeSelection, Plugin, TextSelection, type SelectionBookmark, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { Fragment, Slice, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { lift } from "@milkdown/kit/prose/commands";
import { liftListItem } from "@milkdown/kit/prose/schema-list";
import { wrappingInputRule } from "@milkdown/kit/prose/inputrules";
import { markRule } from "@milkdown/kit/prose";
import { closeHistory, undoDepth, redoDepth } from "@milkdown/kit/prose/history";
import { $prose, $remark, $inputRule, callCommand, getMarkdown } from "@milkdown/kit/utils";
import { Bold, Ellipsis, Italic, Link, Quote, List, ListOrdered, Table2, Undo2, Redo2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { BODY_MAX_LENGTH, EDITOR_BODY_REPLACED_EVENT, EDITOR_STRINGIFY_OPTIONS, preserveEditorSource, requiresMarkdownEditor } from "~/lib/rich-editor";
import { startsWithFrontmatter } from "~/lib/text";
import { parseMediaPath } from "~/lib/media";
import { registerMediaEditor } from "~/lib/media-editor-client";
import { remarkMarkdownRules } from "~/lib/markdown-rules";
import { remarkEditorAttention } from "~/lib/editor-markdown";
import { mentionQueryAt } from "~/lib/mention-syntax";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import "./rich-text-editor.css";

const markdownRules = $remark("markdownRules", () => remarkMarkdownRules);
const editorAttention = $remark("editorAttention", () => remarkEditorAttention);
const orderedListInput = $inputRule(ctx => wrappingInputRule(/^1\. $/, orderedListSchema.type(ctx), { order: 1 },
  (_match, node) => node.childCount + node.attrs.order === 1));
const doubleTildeInput = $inputRule(ctx => markRule(/(?<![\w:/~])(~~)(.+?)\1(?!~)$/, strikethroughSchema.type(ctx)));

export type RichTextEditorProps = {
  invalid?: boolean;
  describedBy?: string;
  compact?: boolean;
  // Shown inside the empty editor.
  placeholder?: string;
  // A tall field for long-form writing.
  tall?: boolean;
  id: string;
  lang?: string;
  textarea: () => HTMLTextAreaElement;
  pasteFrontmatter: boolean;
  onReady: () => void;
  isComposing: () => boolean;
  onFallback: () => void;
  sync: RefObject<(() => void) | null>;
};

function localImages(fragment: Fragment): Fragment {
  const nodes: ProseNode[] = [];
  fragment.forEach(node => {
    if (node.type.name !== "image" || parseMediaPath(node.attrs.src)) nodes.push(node.isLeaf ? node : node.copy(localImages(node.content)));
  });
  return Fragment.fromArray(nodes);
}

function formats(state: EditorState) {
  const { $from, from, to, empty } = state.selection;
  const mark = (name: string) => empty
    ? (state.storedMarks ?? $from.marks()).some(mark => mark.type.name === name)
    : state.doc.rangeHasMark(from, to, state.schema.marks[name]);
  const ancestors = Array.from({ length: $from.depth }, (_, i) => $from.node(i + 1).type.name);
  return { bold: mark("strong"), italic: mark("emphasis"), link: mark("link"), heading: $from.parent.type.name === "heading" ? $from.parent.attrs.level as number : 0,
    quote: ancestors.includes("blockquote"), bullet: ancestors.includes("bullet_list"), ordered: ancestors.includes("ordered_list"), table: ancestors.includes("table"), undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 };
}

function selectedLink(state: EditorState) {
  const { from, to } = state.selection;
  let result: { from: number; to: number; href: string } | undefined;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const end = pos + node.nodeSize;
    if (from === to ? pos > from || end <= from : pos >= to || end <= from) return;
    const mark = node.marks.find(mark => mark.type.name === "link");
    if (mark && (!result || result.href === mark.attrs.href)) {
      result = { from: Math.min(result?.from ?? pos, pos), to: Math.max(result?.to ?? 0, pos + node.nodeSize), href: mark.attrs.href as string };
    }
  });
  return result;
}

function syncNativeSelection(view: EditorView, event: KeyboardEvent) {
  if (!/^(End|Home|Arrow(Left|Right|Up|Down)|Page(Up|Down))$/.test(event.key) ||
    event.isComposing || event.keyCode === 229 || view.composing || !view.hasFocus() ||
    !(view.state.selection instanceof TextSelection)) return false;
  const selection = view.dom.ownerDocument.getSelection();
  if (!selection?.anchorNode || !selection.focusNode ||
    !view.dom.contains(selection.anchorNode) || !view.dom.contains(selection.focusNode)) return false;
  // Native movement has finished, but selectionchange can arrive after the next
  // typing command. Read it now so Enter cannot replace an obsolete selection.
  const anchor = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  const head = view.posAtDOM(selection.focusNode, selection.focusOffset);
  const next = TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head));
  if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next));
  return false;
}

export function RichTextEditor({ invalid, describedBy, placeholder, tall = false, id, lang, textarea, pasteFrontmatter, onReady, isComposing, onFallback, sync }: RichTextEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const placeholderText = useRef(placeholder ?? "");
  const [moreOpen, setMoreOpen] = useState(false);
  // Handle suggestions for an @mention being typed: what the cursor is in (where it starts and what is typed), the handles asked of /mentions/suggest, and where to draw the list.
  const [mention, setMention] = useState<{ items: string[]; names: Record<string, { label?: string | null }>; active: number; left: number; top: number } | null>(null);
  const mentionApi = useRef<{ choose: (handle: string) => void; move: (delta: number) => void; close: () => void } | null>(null);
  const instance = useRef<Editor | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = toolbar.current!;
    let current: HTMLButtonElement | undefined;
    // A button hidden by the narrow-screen layout is not a stop of the toolbar.
    const buttons = () => Array.from(bar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")).filter(item => item.getClientRects().length > 0);
    const update = () => {
      const items = buttons();
      if (!current || !items.includes(current)) current = items[0];
      items.forEach(item => { item.tabIndex = item === current ? 0 : -1; });
      bar.querySelectorAll<HTMLButtonElement>("button").forEach(item => { if (!items.includes(item)) item.tabIndex = -1; });
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLButtonElement) { current = event.target; update(); }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof HTMLButtonElement)) return;
      const items = buttons(), index = items.indexOf(event.target);
      if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const forward = (event.key === "ArrowRight") !== (getComputedStyle(bar).direction === "rtl");
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (forward ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    update();
    bar.addEventListener("focusin", focus);
    bar.addEventListener("keydown", keydown);
    const observer = new MutationObserver(update);
    observer.observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); bar.removeEventListener("focusin", focus); bar.removeEventListener("keydown", keydown); };
  }, []);
  const [ready, setReady] = useState(false);
  // On a narrow screen the toolbar rides just above the on-screen keyboard while the editor has the cursor, so that formatting does not mean scrolling back up.
  const toolbarSlot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const bar = toolbar.current, slot = toolbarSlot.current, wrap = root.current?.closest<HTMLElement>(".rich-text-editor");
    if (!viewport || !bar || !slot || !wrap) return;
    const narrow = window.matchMedia("(max-width: 639px)");
    let focused = false, floating = false;
    const place = () => {
      const keyboard = window.innerHeight - viewport.height - viewport.offsetTop;
      const show = focused && narrow.matches && keyboard > 80;
      if (show && !floating) slot.style.minHeight = `${bar.offsetHeight}px`;
      if (!show && floating) slot.style.minHeight = "";
      floating = show;
      wrap.toggleAttribute("data-keyboard", show);
      if (show) wrap.style.setProperty("--keyboard-inset", `${Math.max(0, keyboard)}px`); else wrap.style.removeProperty("--keyboard-inset");
    };
    const focusin = (event: FocusEvent) => { if (root.current?.contains(event.target as Node)) { focused = true; place(); } };
    const focusout = (event: FocusEvent) => { if (!wrap.contains(event.relatedTarget as Node)) { focused = false; place(); } };
    wrap.addEventListener("focusin", focusin);
    wrap.addEventListener("focusout", focusout);
    viewport.addEventListener("resize", place);
    viewport.addEventListener("scroll", place);
    return () => { wrap.removeEventListener("focusin", focusin); wrap.removeEventListener("focusout", focusout); viewport.removeEventListener("resize", place); viewport.removeEventListener("scroll", place); wrap.removeAttribute("data-keyboard"); wrap.style.removeProperty("--keyboard-inset"); };
  }, []);
  useEffect(() => {
    placeholderText.current = placeholder ?? "";
    // Draw the empty field again with the new text.
    const view = instance.current?.action(ctx => ctx.get(editorViewCtx));
    if (view) view.dispatch(view.state.tr);
  }, [placeholder, ready]);
  const [pressed, setPressed] = useState({ bold: false, italic: false, link: false, heading: 0, quote: false, bullet: false, ordered: false, table: false, undo: false, redo: false });
  useEffect(() => {
    instance.current?.action(ctx => ctx.get(editorViewCtx).setProps({ attributes: {
      id, dir: "auto", role: "textbox", "aria-label": m.field_body(), "aria-multiline": "true",
      "aria-invalid": invalid ? "true" : "false", "aria-describedby": describedBy ?? "",
    } }));
  }, [ready, invalid, describedBy, id]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const bookmark = useRef<SelectionBookmark | null>(null);
  const imageBookmark = useRef<SelectionBookmark | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imagePanel = useRef<HTMLDivElement>(null);
  const focusRequest = useRef(0);
  const [imageEdit, setImageEdit] = useState<{ value: string; focus: number } | null>(null);
  useEffect(() => {
    if (imageEdit?.focus) { imageInput.current?.focus({ preventScroll: true }); imageInput.current?.select(); }
  }, [imageEdit?.focus]);
  useLayoutEffect(() => {
    const panel = imagePanel.current;
    const view = instance.current?.action(ctx => ctx.get(editorViewCtx));
    const selection = view && imageBookmark.current?.resolve(view.state.doc);
    const image = selection && view?.nodeDOM(selection.from);
    const frame = root.current?.closest(".rich-text-editor-frame");
    if (!imageEdit || !panel || !(image instanceof HTMLElement) || !frame) return;
    const viewport = window.visualViewport;
    const place = () => {
      const rect = image.getBoundingClientRect(), bounds = frame.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
      panel.style.width = `${Math.min(bounds.width, window.innerWidth - 16)}px`;
      panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(top + 8, Math.min(rect.bottom + 8, bottom - panel.offsetHeight - 8))}px`;
    };
    const reveal = () => { image.scrollIntoView({ block: "nearest", inline: "nearest" }); place(); };
    // Scrolling can resize a mobile viewport; reveal only while editing the description.
    const resizeViewport = () => { if (document.activeElement === imageInput.current) reveal(); else place(); };
    if (imageEdit.focus && document.activeElement !== imageInput.current) reveal();
    else place();
    // The intrinsic image size arrives after insertion. Keep the image and its
    // description together when it loads or the on-screen keyboard opens.
    image.addEventListener("load", reveal);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", resizeViewport);
    viewport?.addEventListener("scroll", place);
    return () => {
      image.removeEventListener("load", reveal);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", resizeViewport);
      viewport?.removeEventListener("scroll", place);
    };
  }, [imageEdit]);
  const editImage = (view: EditorView, focus = false) => {
    if (!(view.state.selection instanceof NodeSelection) || view.state.selection.node.type.name !== "image") return;
    imageBookmark.current = view.state.selection.getBookmark();
    setLinkOpen(false);
    setImageEdit({ value: view.state.selection.node.attrs.alt, focus: focus ? ++focusRequest.current : 0 });
  };

  useEffect(() => {
    const body = textarea();
    let source = body.value;
    if (requiresMarkdownEditor(source)) { onFallback(); return; }
    let cancelled = false;
    let initial: string | undefined;
    let unregisterMedia: (() => void) | undefined;
    let activationFrame = 0;
    const editor = Editor.make();
    const write = (value: string) => {
      body.value = value;
      body.setCustomValidity(value.length > BODY_MAX_LENGTH ? m.error_body_too_long() : "");
      body.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const synchronize = () => {
      if (initial === undefined || cancelled) return;
      const value = preserveEditorSource(source, initial, editor.action(getMarkdown()));
      if (body.value !== value) write(value);
    };
    const replaceBody = () => {
      if (initial === undefined || cancelled) return;
      // AI import replaces the native value. Adopt it without serializing over its literal source.
      initial = undefined;
      source = body.value;
      if (requiresMarkdownEditor(source)) { sync.current = null; onFallback(); return; }
      try {
        const view = editor.action(ctx => ctx.get(editorViewCtx));
        const doc = editor.action(ctx => ctx.get(parserCtx)(source));
        view.dispatch(closeHistory(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)));
        initial = editor.action(getMarkdown());
        setPressed(formats(view.state));
      } catch { sync.current = null; onFallback(); }
    };
    body.addEventListener(EDITOR_BODY_REPLACED_EVENT, replaceBody);
    const paste = (view: EditorView, event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if ((pasteFrontmatter && startsWithFrontmatter(text)) || text.includes("$")) {
        event.preventDefault();
        synchronize();
        // Keep both the literal paste and the current body. Frontmatter must be
        // first for the existing form's title/language handling to recognize it.
        write(text + (body.value ? "\n\n" + body.value : ""));
        initial = undefined;
        sync.current = null;
        onFallback();
        queueMicrotask(() => body.focus());
        return true;
      }
      if (!event.clipboardData?.getData("text/html") && /!\[/.test(text)) {
        event.preventDefault();
        view.dispatch(view.state.tr.replaceSelection(new Slice(localImages(editor.action(ctx => ctx.get(parserCtx)(text.trimEnd())).content), 0, 0)));
        return true;
      }
      return false;
    };
    const selectImage = (view: EditorView, _pos: number, node: ProseNode, nodePos: number, event: MouseEvent, direct: boolean) => {
      if (!direct || node.type.name !== "image" || event.button !== 0) return false;
      view.dispatch(closeHistory(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)).setMeta("pointer", true)));
      // Restore the native selection even when the same atom is selected again.
      view.focus();
      editImage(view);
      return true;
    };
    const bridge = $prose(ctx => new Plugin({
      state: { init: () => null, apply: transaction => {
        if (imageBookmark.current) imageBookmark.current = imageBookmark.current.map(transaction.mapping);
        return null;
      } },
      props: {
        transformPasted: slice => new Slice(localImages(slice.content), slice.openStart, slice.openEnd),
        handleClickOn: selectImage,
        handleDoubleClickOn: selectImage,
        handleTripleClickOn: selectImage,
      },
      view: () => ({ update: (view, previous) => {
        if (initial === undefined || cancelled) return;
        if (!view.state.doc.eq(previous.doc)) {
          const value = preserveEditorSource(source, initial, ctx.get(serializerCtx)(view.state.doc));
          write(value);
          if (requiresMarkdownEditor(value)) {
            initial = undefined;
            sync.current = null;
            onFallback();
            queueMicrotask(() => body.focus());
          }
        }
        setPressed(formats(view.state));
        if (view.state.selection instanceof NodeSelection && view.state.selection.node.type.name === "image") {
          if (!view.state.selection.eq(previous.selection)) editImage(view);
        } else { imageBookmark.current = null; setImageEdit(null); }
      } }),
    }));
    // The text of an empty editor: a paragraph that is the whole document gets it as a decoration.
    const emptyHint = $prose(() => new Plugin({
      props: { decorations: state => {
        const first = state.doc.firstChild;
        return state.doc.childCount === 1 && first && first.type.name === "paragraph" && first.content.size === 0 && placeholderText.current
          ? DecorationSet.create(state.doc, [Decoration.node(0, first.nodeSize, { class: "is-editor-empty", "data-placeholder": placeholderText.current })]) : null;
      } },
    }));
    // Handle suggestions: the text before the cursor decides (the same rule as the Markdown field), the handles are asked of the server after a short pause, and the arrow keys,
    // Enter, Tab and Escape work on the list the way they do in the Markdown field (not while a composition of an input method is open).
    let mentionTimer: ReturnType<typeof setTimeout> | undefined;
    let mentionRequest: AbortController | undefined;
    let mentionFound: { from: number; query: string } | null = null;
    let mentionItems: string[] = [];
    let mentionNames: Record<string, { label?: string | null }> = {};
    let mentionActive = 0;
    const closeMention = () => {
      clearTimeout(mentionTimer); mentionRequest?.abort(); mentionRequest = undefined;
      mentionFound = null; mentionItems = []; mentionActive = 0;
      setMention(null);
    };
    const showMention = (view: EditorView) => {
      if (!mentionFound || !mentionItems.length) { setMention(null); return; }
      const coords = view.coordsAtPos(view.state.selection.from);
      setMention({ items: mentionItems, names: mentionNames, active: mentionActive, left: coords.left, top: coords.bottom + 4 });
    };
    const lookupMention = (view: EditorView) => {
      const { selection } = view.state;
      if (!selection.empty || !selection.$from.parent.isTextblock || view.composing) { if (mentionFound) closeMention(); return; }
      const { $from } = selection;
      const found = mentionQueryAt($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"));
      if (!found) { if (mentionFound) closeMention(); return; }
      const from = $from.start() + found.start;
      if (mentionFound?.query === found.query && mentionFound.from === from) { showMention(view); return; }
      mentionRequest?.abort(); mentionRequest = undefined;
      mentionItems = []; mentionActive = 0; setMention(null);
      mentionFound = { from, query: found.query };
      clearTimeout(mentionTimer);
      mentionTimer = setTimeout(async () => {
        const asked = mentionFound;
        if (!asked || asked.query !== found.query || asked.from !== from) return;
        const controller = new AbortController();
        mentionRequest = controller;
        try {
          const response = await fetch(`/mentions/suggest?q=${encodeURIComponent(found.query.normalize("NFKC").toLowerCase())}&lang=${getLocale()}`, { credentials: "same-origin", signal: controller.signal, headers: { accept: "application/json" } });
          if (!response.ok || controller.signal.aborted || mentionRequest !== controller) return;
          const result = await response.json() as { handles?: unknown; names?: Record<string, { label?: string | null }> };
          if (controller.signal.aborted || mentionRequest !== controller || mentionFound?.query !== found.query || mentionFound.from !== from) return;
          mentionNames = result.names ?? {};
          mentionItems = Array.isArray(result.handles) ? result.handles.filter((handle): handle is string => typeof handle === "string") : [];
          mentionActive = 0;
          showMention(view);
        } catch { /* Aborted, offline or not JSON: no suggestions. */ }
      }, 150);
    };
    const chooseMention = (view: EditorView, handle: string) => {
      if (!mentionFound) return;
      const { from } = mentionFound;
      closeMention();
      view.dispatch(view.state.tr.insertText(`@${handle} `, from, view.state.selection.from));
      view.focus();
    };
    mentionApi.current = {
      choose: handle => { const view = editor.action(ctx => ctx.get(editorViewCtx)); chooseMention(view, handle); },
      move: delta => { mentionActive = (mentionActive + delta + mentionItems.length) % mentionItems.length; const view = editor.action(ctx => ctx.get(editorViewCtx)); showMention(view); },
      close: closeMention,
    };
    const mentions = $prose(() => new Plugin({
      props: {
        handleKeyDown: (view, event) => {
          if (!mentionItems.length || event.isComposing || event.keyCode === 229) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); mentionApi.current?.move(event.key === "ArrowDown" ? 1 : -1); return true; }
          if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); chooseMention(view, mentionItems[mentionActive]); return true; }
          if (event.key === "Escape") { event.preventDefault(); closeMention(); return true; }
          return false;
        },
        handleDOMEvents: { blur: () => { closeMention(); return false; } },
      },
      view: () => ({ update: view => lookupMention(view), destroy: closeMention }),
    }));
    editor.config(ctx => {
      ctx.set(rootCtx, root.current!);
      ctx.set(defaultValueCtx, source);
      // CommonMark represents an absent image title/alt as null. Milkdown's
      // image schema requires strings; keep title-less media Markdown usable.
      ctx.update(imageSchema.key, previous => ctx => {
        const schema = previous(ctx);
        return { ...schema, parseMarkdown: {
          ...schema.parseMarkdown,
          runner: (state, node, type) => state.addNode(type, { src: node.url as string, alt: node.alt ?? "", title: node.title ?? "" }),
        } };
      });
      ctx.update(remarkStringifyOptionsCtx, previous => {
        // Let the CJK extension handle attention boundaries and text escaping.
        // Milkdown's defaults bypass escaping for text ending in whitespace.
        const { strong, emphasis, text, ...handlers } = previous.handlers ?? {};
        return { ...previous, ...EDITOR_STRINGIFY_OPTIONS, handlers };
      });
      ctx.update(editorViewOptionsCtx, previous => ({ ...previous,
        attributes: { id, dir: "auto", role: "textbox", "aria-label": m.field_body(), "aria-multiline": "true" },
        handleDOMEvents: { ...previous.handleDOMEvents, paste, keyup: syncNativeSelection },
        transformPastedHTML: html => {
          const template = document.createElement("template");
          template.innerHTML = html;
          template.content.querySelectorAll("img").forEach(image => { if (!parseMediaPath(image.getAttribute("src") ?? "")) image.remove(); });
          return template.innerHTML;
        },
      }));
    }).use(commonmark.filter(plugin => plugin !== wrapInOrderedListInputRule))
      .use(gfm.filter(plugin => plugin !== remarkGFMPlugin.plugin && plugin !== remarkGFMPlugin.options && plugin !== strikethroughInputRule))
      .use(markdownRules).use(editorAttention).use(orderedListInput).use(doubleTildeInput).use(clipboard).use(history).use(emptyHint).use(mentions).use(bridge);
    instance.current = editor;
    const activate = () => {
      if (cancelled || isComposing()) return;
      if (requiresMarkdownEditor(body.value)) { onFallback(); return; }
      const view = editor.action(ctx => ctx.get(editorViewCtx));
      // Adopt the latest native input before establishing the untouched-source
      // baseline. This also covers typing during asynchronous editor creation.
      if (body.value !== source) {
        source = body.value;
        const doc = editor.action(ctx => ctx.get(parserCtx)(source));
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta("addToHistory", false));
      }
      initial = editor.action(getMarkdown());
      sync.current = synchronize;
      unregisterMedia = registerMediaEditor(body, { element: view.dom, insert: (url, alt) => {
        if (!parseMediaPath(url) || cancelled) return;
        const { state } = view;
        const cursor = state.selection.$head;
        const pos = view.hasFocus() && cursor.depth ? cursor.after() : state.doc.content.size;
        const image = state.schema.nodes.image.create({ src: url, alt, title: "" });
        const paragraph = state.schema.nodes.paragraph.create(null, image);
        const transaction = closeHistory(state.tr.insert(pos, paragraph));
        transaction.setSelection(NodeSelection.create(transaction.doc, pos + 1));
        view.dispatch(transaction.scrollIntoView());
        editImage(view, true);
      } });
      setPressed(formats(editor.action(ctx => ctx.get(editorViewCtx).state)));
      const focused = document.activeElement === body;
      const { scrollX, scrollY } = window;
      flushSync(() => { setReady(true); onReady(); });
      if (focused) {
        view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
        view.dom.focus({ preventScroll: true });
        view.focus();
      }
      window.scrollTo(scrollX, scrollY);
    };
    const afterComposition = () => {
      // The committed input event must reach the textarea before adoption.
      if (editor.status === "Created" && initial === undefined) activationFrame = requestAnimationFrame(activate);
    };
    body.addEventListener("compositionend", afterComposition);
    void editor.create().then(() => {
      if (cancelled) { void editor.destroy(); return; }
      activate();
    }).catch(() => { if (!cancelled) onFallback(); });
    return () => {
      synchronize();
      cancelled = true;
      cancelAnimationFrame(activationFrame);
      body.removeEventListener("compositionend", afterComposition);
      body.removeEventListener(EDITOR_BODY_REPLACED_EVENT, replaceBody);
      unregisterMedia?.();
      sync.current = null;
      instance.current = null;
      if (editor.status === "Created") void editor.destroy();
    };
  }, []);

  const run = (fn: (editor: Editor, view: EditorView) => void) => {
    const editor = instance.current;
    if (!editor || !ready) return;
    editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      fn(editor, view);
      // A toolbar click keeps focus; only restore it after a keyboard activation
      // or a link input, without restarting the observer unnecessarily.
      if (!view.hasFocus()) view.focus();
    });
  };
  const openLink = () => run((_editor, view) => {
    imageBookmark.current = null;
    setImageEdit(null);
    bookmark.current = view.state.selection.getBookmark();
    setUrl(selectedLink(view.state)?.href ?? "");
    setLinkOpen(true);
  });
  const applyLink = (remove = false) => run((_editor, view) => {
    const selection = bookmark.current?.resolve(view.state.doc) ?? view.state.selection;
    const state = view.state.apply(view.state.tr.setSelection(selection));
    const existing = selectedLink(state);
    const from = existing?.from ?? selection.from;
    const to = existing?.to ?? selection.to;
    let transaction = view.state.tr.setSelection(selection).removeMark(from, to, state.schema.marks.link);
    if (!remove && url.trim()) {
      const mark = state.schema.marks.link.create({ href: url.trim() });
      transaction = from === to ? transaction.addStoredMark(mark) : transaction.addMark(from, to, mark);
    } else transaction = transaction.removeStoredMark(state.schema.marks.link);
    view.dispatch(transaction);
    setLinkOpen(false);
  });
  const applyImage = (focus = false) => {
    const editor = instance.current;
    if (!editor || !imageEdit) return;
    editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const selection = imageBookmark.current?.resolve(view.state.doc);
      imageBookmark.current = null;
      setImageEdit(null);
      if (selection instanceof NodeSelection && selection.node.type.name === "image" && selection.node.attrs.alt !== imageEdit.value) {
        view.dispatch(closeHistory(view.state.tr.setNodeMarkup(selection.from, undefined, { ...selection.node.attrs, alt: imageEdit.value })));
      }
      if (focus) view.focus();
    });
  };
  const insertTable = () => run((editor, view) => {
    const from = view.state.selection.from;
    editor.action(callCommand(insertTableCommand.key, { row: 3, col: 3 }));
    // Inserting a block in the middle of a paragraph can leave the standard
    // command's selection in the preceding text. Always enter the new table.
    let tablePos: number | undefined;
    view.state.doc.nodesBetween(from, view.state.doc.content.size, (node, pos) => {
      if (tablePos === undefined && node.type.name === "table") tablePos = pos;
      return tablePos === undefined;
    });
    if (tablePos !== undefined) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(tablePos + 1))).scrollIntoView());
  });
  const deleteTablePart = (row: boolean) => run((editor, view) => {
    const { $from } = view.state.selection;
    let depth = $from.depth;
    while (depth && $from.node(depth).type.spec.tableRole !== "row") depth--;
    if (!depth) return;
    const index = $from.index(row ? depth - 1 : depth);
    editor.action(callCommand(row ? selectRowCommand.key : selectColCommand.key, { index }));
    if (!row || index !== 0) { editor.action(callCommand(deleteSelectedCellsCommand.key)); return; }
    const pos = $from.before(depth - 1);
    editor.action(ctx => ctx.get(commandsCtx).get(deleteSelectedCellsCommand.key)()(view.state, transaction => {
      const table = transaction.doc.nodeAt(pos);
      // The GFM schema requires a header. Promote the next row before the
      // table-editing plugin sees the empty header inserted by row deletion.
      if (table?.type.name === "table" && table.firstChild?.childCount === 0 && table.childCount > 1) {
        const first = table.child(1), { nodes } = view.state.schema;
        const cells = Array.from({ length: first.childCount }, (_, i) => {
          const cell = first.child(i);
          return nodes.table_header.create(cell.attrs, cell.content, cell.marks);
        });
        const rows: ProseNode[] = [nodes.table_header_row.create(first.attrs, cells, first.marks)];
        table.forEach((child, _offset, i) => { if (i > 1) rows.push(child); });
        if (rows.length === 1) rows.push(nodes.table_row.create(null,
          Array.from({ length: first.childCount }, (_, i) => nodes.table_cell.createAndFill(first.child(i).attrs)!)));
        transaction.replaceWith(pos, pos + table.nodeSize, table.copy(Fragment.fromArray(rows)));
        transaction.setSelection(TextSelection.near(transaction.doc.resolve(pos + 1)));
      }
      view.dispatch(transaction.scrollIntoView());
    }, view));
  });
  // `secondary` tools are folded behind "…" on a narrow screen; every tool is in the row from the small breakpoint up.
  const groups = [[
    { label: m.editor_heading(), pressed: pressed.heading === 2, action: () => run(editor => editor.action(callCommand(wrapInHeadingCommand.key, pressed.heading === 2 ? 0 : 2))) },
    { label: m.editor_subheading(), secondary: true, pressed: pressed.heading === 3, action: () => run(editor => editor.action(callCommand(wrapInHeadingCommand.key, pressed.heading === 3 ? 0 : 3))) },
    { label: m.editor_quote(), icon: Quote, secondary: true, pressed: pressed.quote, action: () => run((editor, view) => pressed.quote ? lift(view.state, view.dispatch) : editor.action(callCommand(wrapInBlockquoteCommand.key))) },
    { label: m.editor_bullet_list(), icon: List, pressed: pressed.bullet, action: () => run((editor, view) => pressed.bullet ? liftListItem(view.state.schema.nodes.list_item)(view.state, view.dispatch) : editor.action(callCommand(wrapInBulletListCommand.key))) },
    { label: m.editor_ordered_list(), icon: ListOrdered, secondary: true, pressed: pressed.ordered, action: () => run((editor, view) => pressed.ordered ? liftListItem(view.state.schema.nodes.list_item)(view.state, view.dispatch) : editor.action(callCommand(wrapInOrderedListCommand.key))) },
  ], [
    { label: m.editor_bold(), icon: Bold, pressed: pressed.bold, action: () => run(editor => editor.action(callCommand(toggleStrongCommand.key))) },
    { label: m.editor_italic(), icon: Italic, secondary: true, pressed: pressed.italic, action: () => run(editor => editor.action(callCommand(toggleEmphasisCommand.key))) },
    { label: m.editor_link(), icon: Link, pressed: pressed.link, action: openLink },
  ], [
    { label: m.editor_table(), icon: Table2, secondary: true, disabled: pressed.table, action: insertTable },
    ...(pressed.table ? [
      { label: m.editor_table_add_row(), secondary: true, action: () => run(editor => editor.action(callCommand(addRowAfterCommand.key))) },
      { label: m.editor_table_add_column(), secondary: true, action: () => run(editor => editor.action(callCommand(addColAfterCommand.key))) },
      { label: m.editor_table_delete_row(), secondary: true, action: () => deleteTablePart(true) },
      { label: m.editor_table_delete_column(), secondary: true, action: () => deleteTablePart(false) },
    ] : []),
  ], [
    { label: m.editor_undo(), icon: Undo2, secondary: true, disabled: !pressed.undo, action: () => run(editor => editor.action(callCommand(undoCommand.key))) },
    { label: m.editor_redo(), icon: Redo2, secondary: true, disabled: !pressed.redo, action: () => run(editor => editor.action(callCommand(redoCommand.key))) },
  ]];
  const foldedClass = moreOpen ? "" : "max-sm:hidden";
  return <div hidden={!ready} className="rich-text-editor min-w-0 space-y-2">
    {/* The slot sticks to the top of the screen while the editor is scrolled through; on a narrow screen with the keyboard up the toolbar inside it moves above the keyboard. */}
    <div ref={toolbarSlot} className="sticky top-0 z-10 bg-background"><div ref={toolbar} role="toolbar" aria-label={m.editor_toolbar()} className="editor-toolbar flex flex-wrap items-center gap-y-1 bg-background py-1">
      {groups.map((tools, index) => <div key={index} className={`${tools.every(tool => "secondary" in tool && tool.secondary) ? foldedClass : ""} flex flex-wrap gap-1 not-first:ms-2 not-first:border-s not-first:border-border not-first:ps-2`}>
        {tools.map(tool => <Button key={tool.label} type="button" variant={"pressed" in tool && tool.pressed ? "default" : "outline"}
          size={"icon" in tool ? "icon" : "default"} aria-label={tool.label} title={tool.label} aria-pressed={"pressed" in tool ? tool.pressed : undefined}
          disabled={"disabled" in tool && tool.disabled}
          className={`h-10 ${"icon" in tool ? "min-w-10" : "px-3"} text-sm aria-pressed:border-foreground aria-pressed:ring-1 aria-pressed:ring-foreground ${"secondary" in tool && tool.secondary ? foldedClass : ""}`}
          onMouseDown={event => event.preventDefault()} onClick={tool.action}>{"icon" in tool && tool.icon ? <tool.icon aria-hidden="true" /> : tool.label}</Button>)}
      </div>)}
      <div data-editor-media-slot className="ms-2 border-s border-border ps-2 empty:hidden" />
      <Button type="button" variant="outline" size="icon" aria-label={m.editor_more()} title={m.editor_more()} aria-expanded={moreOpen} className="ms-2 h-10 min-w-10 sm:hidden" onMouseDown={event => event.preventDefault()} onClick={() => setMoreOpen(open => !open)}><Ellipsis aria-hidden="true" /></Button>
    </div></div>
    {linkOpen && <div className="flex flex-wrap items-center gap-2">
      <Input autoFocus type="url" aria-label={m.editor_link_url()} value={url} onChange={event => setUrl(event.target.value)} className="min-w-0 flex-1"
        onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); applyLink(); } if (event.key === "Escape") { event.preventDefault(); setLinkOpen(false); run(() => {}); } }} />
      <Button type="button" variant="outline" onClick={() => applyLink()}>{m.editor_link_apply()}</Button>
      <Button type="button" variant="outline" onClick={() => applyLink(true)}>{m.editor_link_remove()}</Button>
    </div>}
    {imageEdit && <div ref={imagePanel} className="fixed z-30 flex items-center gap-2 rounded border bg-background p-2 shadow">
      <Input ref={imageInput} aria-label={m.media_alt_placeholder()} placeholder={m.media_alt_placeholder()} value={imageEdit.value} className="min-w-0 flex-1"
        onChange={event => setImageEdit({ ...imageEdit, value: event.target.value })} onBlur={() => applyImage()}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); applyImage(true); }
          if (event.key === "Escape") { event.preventDefault(); imageBookmark.current = null; setImageEdit(null); run(() => {}); }
        }} />
    </div>}
    {mention && <ul role="listbox" aria-label={m.mention_suggestions_label()} style={{ left: mention.left, top: mention.top }} className="fixed z-50 max-h-48 min-w-40 overflow-auto rounded border bg-popover py-1 shadow">
      {mention.items.map((handle, index) => <li key={handle} role="option" aria-selected={index === mention.active}
        // The mouse down is taken before the editor would lose focus (which would close the list before the click arrives).
        onMouseDown={event => { event.preventDefault(); mentionApi.current?.choose(handle); }}
        className={`cursor-pointer px-3 py-1 ${index === mention.active ? "bg-sky-100" : ""}`}>{mention.names[handle]?.label && <bdi>{mention.names[handle].label} </bdi>}@{handle}</li>)}
    </ul>}
    <p className="sr-only" role="status" aria-live="polite">{mention ? m.mention_suggestions_status({ count: mention.items.length }) : ""}</p>
    <div lang={lang} className={`rich-text-editor-frame ${tall ? "rich-text-tall" : ""} min-w-0 w-full rounded-lg border border-input px-2.5 py-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50`}>
      <div ref={root} lang={lang} dir="auto" className="longread min-w-0" />
    </div>
  </div>;
}
