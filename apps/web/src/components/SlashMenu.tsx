import { For, Show, createEffect, createMemo } from "solid-js";
import type { SlashCommand } from "@picone/protocol";

export interface SlashMenuProps {
  commands: SlashCommand[];
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}

const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  app: "picone",
  builtin: "pi",
  extension: "extension",
  prompt: "prompt",
  skill: "skill",
};

/** Filters a list of slash commands by prefix, then by substring. */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const needle = query.toLowerCase();
  if (!needle) return commands.slice(0, 50);
  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (name.includes(needle)) contains.push(command);
  }
  return [...prefix, ...contains].slice(0, 50);
}

export function SlashMenu(props: SlashMenuProps) {
  let list: HTMLDivElement | undefined;

  const items = createMemo(() => props.commands);

  createEffect(() => {
    // Keep the highlighted row in view while arrowing through a long list.
    const index = props.activeIndex;
    const el = list?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });

  return (
    <Show when={items().length > 0}>
      <div data-component="slash-menu" ref={list} role="listbox">
        <For each={items()}>
          {(command, index) => (
            <button
              type="button"
              role="option"
              data-slot="slash-item"
              data-index={index()}
              data-active={props.activeIndex === index() ? "" : undefined}
              aria-selected={props.activeIndex === index()}
              onMouseEnter={() => props.onHover(index())}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onPick(command)}
            >
              <span data-slot="slash-name">/{command.name}</span>
              <Show when={command.description}>
                <span data-slot="slash-desc">{command.description}</span>
              </Show>
              <span data-slot="slash-source">{SOURCE_LABEL[command.source]}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
