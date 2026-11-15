// Embed form used by announcements and button-role panels. Limits show inline as you type.
import { ADMIN_TOOLS_LIMITS as L, type EmbedDto } from '@tcg-live/core';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Input, Switch, Textarea } from '../../../ui';
import { embedProblems, embedTotal, hexColor, parseHexColor } from './embed';

export function EmbedEditor({ value, onChange, disabled }: { value: EmbedDto; onChange(next: EmbedDto): void; disabled?: boolean }) {
  const problems = embedProblems(value);
  const set = (patch: Partial<EmbedDto>) => onChange({ ...value, ...patch });
  const text = (input: string) => input === '' ? null : input;
  return <fieldset className="flex flex-col gap-3" disabled={disabled}>
    <legend className="sr-only">Embed</legend>
    <Field label="Title" error={problems.title} description={`${[...(value.title ?? '')].length}/${L.embedTitleLength}`}>
      <Input value={value.title ?? ''} onChange={event => set({ title: text(event.target.value) })} />
    </Field>
    <Field label="Description" error={problems.description}
      description={`Markdown: **bold**, *italic*, __underline__, ~~strike~~, \`code\`, [link](https://…). ${[...(value.description ?? '')].length}/${L.embedDescriptionLength}`}>
      <Textarea rows={5} value={value.description ?? ''} onChange={event => set({ description: text(event.target.value) })} />
    </Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Colour" description="Hex like #f59e0b; empty for Discord's default.">
        <div className="flex items-center gap-2">
          <input type="color" aria-label="Pick colour" value={hexColor(value.color) || '#1e1f22'} className="h-8 w-10 rounded"
            onChange={event => set({ color: parseHexColor(event.target.value) })} />
          <Input aria-label="Colour hex" value={hexColor(value.color)} placeholder="#rrggbb"
            onChange={event => set({ color: event.target.value.trim() ? parseHexColor(event.target.value) ?? value.color : null })} />
        </div>
      </Field>
      <Field label="Footer" error={problems.footer}>
        <Input value={value.footer ?? ''} onChange={event => set({ footer: text(event.target.value) })} />
      </Field>
      <Field label="Image URL" error={problems.imageUrl} description="https:// only.">
        <Input value={value.imageUrl ?? ''} onChange={event => set({ imageUrl: text(event.target.value.trim()) })} />
      </Field>
      <Field label="Thumbnail URL" error={problems.thumbnailUrl} description="https:// only.">
        <Input value={value.thumbnailUrl ?? ''} onChange={event => set({ thumbnailUrl: text(event.target.value.trim()) })} />
      </Field>
    </div>
    <section aria-label="Embed fields" className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h4 className="flex-1 text-[13px] font-medium text-fg">Fields ({value.fields.length}/{L.embedFields})</h4>
        <Button size="sm" icon={<Plus />} disabled={disabled || value.fields.length >= L.embedFields}
          onClick={() => set({ fields: [...value.fields, { name: '', value: '', inline: false }] })}>Add field</Button>
      </header>
      {value.fields.map((field, index) => <div key={index} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[1fr_2fr_auto_auto]">
        <Input aria-label={`Field ${index + 1} name`} placeholder="Name" value={field.name}
          onChange={event => set({ fields: value.fields.map((item, at) => at === index ? { ...item, name: event.target.value } : item) })} />
        <Textarea aria-label={`Field ${index + 1} value`} rows={1} placeholder="Value" value={field.value}
          onChange={event => set({ fields: value.fields.map((item, at) => at === index ? { ...item, value: event.target.value } : item) })} />
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <Switch size="sm" aria-label={`Field ${index + 1} inline`} checked={field.inline}
            onCheckedChange={inline => set({ fields: value.fields.map((item, at) => at === index ? { ...item, inline } : item) })} />Inline
        </label>
        <IconButton aria-label={`Remove field ${index + 1}`} icon={<Trash2 />} variant="ghost" size="sm"
          onClick={() => set({ fields: value.fields.filter((_, at) => at !== index) })} />
      </div>)}
      {problems.fields && <p role="alert" className="text-xs text-danger">{problems.fields}</p>}
    </section>
    <p className={problems.total ? 'text-xs font-medium text-danger' : 'text-xs text-fg-subtle'}>
      {problems.total ?? `${embedTotal(value)}/6000 characters in total.`}</p>
  </fieldset>;
}
