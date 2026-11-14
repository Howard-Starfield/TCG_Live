// Term list editor: type and press Enter or comma, or paste many lines at once; each term is a chip.
import { X } from 'lucide-react';
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Input } from '../../ui';
import { splitTerms } from './validate';

export interface ChipInputProps {
  label: string;
  values: string[];
  onChange(values: string[]): void;
  max: number;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}

export function ChipInput({ label, values, onChange, max, placeholder = 'Type and press Enter, or paste a list', disabled, mono }: ChipInputProps) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = splitTerms(raw).filter(term => !values.includes(term));
    if (next.length) onChange([...values, ...next]);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (draft.trim()) add(draft);
    } else if (event.key === 'Backspace' && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[\n,]/.test(text)) return;
    event.preventDefault();
    add(`${draft}${text}`);
  };
  return <div className="flex flex-col gap-1.5">
    {values.length > 0 && <ul aria-label={label} className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
      {values.map(value => <li key={value}
        className={`inline-flex h-6 items-center gap-1 rounded-full bg-line-faint pl-2 pr-0.5 text-xs text-fg ${mono ? 'font-mono' : ''}`}>
        <span className="max-w-[14rem] truncate">{value}</span>
        <button type="button" aria-label={`Remove ${value}`} disabled={disabled}
          onClick={() => onChange(values.filter(item => item !== value))}
          className="grid size-5 place-items-center rounded-full text-fg-subtle hover:bg-line hover:text-fg"><X aria-hidden className="size-3" /></button>
      </li>)}
    </ul>}
    <div className="flex items-center gap-2">
      <Input aria-label={`Add to ${label}`} value={draft} placeholder={placeholder} disabled={disabled}
        onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste}
        onBlur={() => { if (draft.trim()) add(draft); }} className={mono ? 'font-mono' : undefined} />
      <span className={`shrink-0 text-2xs tabular-nums ${values.length > max ? 'font-medium text-danger' : 'text-fg-subtle'}`}>{values.length} / {max}</span>
    </div>
  </div>;
}

/** Discord IDs, one per line or comma separated (plain inputs: there is no channel picker data here). */
export function IdListInput({ label, values, onChange, max, disabled }: Omit<ChipInputProps, 'placeholder' | 'mono'>) {
  return <ChipInput label={label} values={values} onChange={onChange} max={max} disabled={disabled} mono
    placeholder="Paste Discord IDs (Developer Mode → Copy ID)" />;
}
