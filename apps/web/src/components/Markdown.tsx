import { createMemo } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: true });

export interface MarkdownProps {
  text: string;
  onOpenFile?: (path: string) => void;
}

/**
 * Rendered markdown for assistant messages and markdown file tabs.
 * Sanitized because the content is model output and arbitrary repository files.
 */
export function Markdown(props: MarkdownProps) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.text, { async: false })));

  return (
    <div
      data-component="markdown"
      onClick={(event) => {
        if (!props.onOpenFile) return;
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        if (/^[a-z]+:/i.test(href) && !href.startsWith("file:")) return;
        event.preventDefault();
        props.onOpenFile(href.replace(/^file:\/\//, ""));
      }}
      innerHTML={html()}
    />
  );
}
