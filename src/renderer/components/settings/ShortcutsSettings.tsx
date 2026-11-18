import { Page, SectionTitle } from './ui';

type Keys = Array<string>;

/** Everything Muse handles from the keyboard. Keep in step with the ? popover in the sidebar. */
const GROUPS: Array<{ title: string; items: Array<{ label: string; keys: Keys; then?: string }> }> = [
  {
    title: 'Anywhere',
    items: [
      { label: 'Import files or folders', keys: ['⌘', 'O'] },
      { label: 'Paste an image or link to import it', keys: ['⌘', 'V'] },
      { label: 'Settings', keys: ['⌘', ','] },
    ],
  },
  {
    title: 'Grid',
    items: [
      { label: 'Bigger thumbnails', keys: ['+'] },
      { label: 'Smaller thumbnails', keys: ['−'] },
      { label: 'Select several', keys: ['⌘'], then: '+ click' },
      { label: 'Clear the selection', keys: ['Esc'] },
    ],
  },
  {
    title: 'Viewing one image',
    items: [
      { label: 'Previous image', keys: ['←'] },
      { label: 'Next image', keys: ['→'] },
      { label: 'Copy the image', keys: ['⌘', 'C'] },
      { label: 'Back to the grid', keys: ['Esc'] },
    ],
  },
];

function Group({ group }: { group: (typeof GROUPS)[number] }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{group.title}</SectionTitle>
      <ul className="bg-gray-950/40 border border-gray-800 rounded-lg px-3.5 py-1.5 divide-y divide-gray-800">
        {group.items.map((item) => (
          <li key={item.label} className="flex items-center justify-between gap-3 py-2">
            <span className="text-sm text-gray-300">{item.label}</span>
            <span className="flex items-center gap-1">
              {item.keys.map((k) => (
                <kbd key={k} className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-200">{k}</kbd>
              ))}
              {item.then && <span className="text-xs text-gray-500">{item.then}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Settings › Shortcuts. */
export function ShortcutsSettings() {
  return (
    <Page title="Shortcuts" intro="The ? beside the gear still shows the short version.">
      <div className="grid grid-cols-2 gap-4 items-start">
        <div className="flex flex-col gap-4">
          <Group group={GROUPS[0]} />
          <Group group={GROUPS[1]} />
        </div>
        <Group group={GROUPS[2]} />
      </div>
    </Page>
  );
}
