import { ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import { createContext, useContext, useId, type AriaAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './cx';
import { springs, useSafeTransition } from './motion';

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  /** Error text; marks the control invalid and is announced through aria-describedby. */
  error?: ReactNode;
  required?: boolean;
  /** Places the label beside the control (for switches). */
  inline?: boolean;
  children: ReactNode;
  className?: string;
}

/** Label, description and error wiring for one control (Input, Textarea, Select or Switch). */
export function Field({ label, description, error, required = false, inline = false, children, className }: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  const labelNode = (
    <label htmlFor={id} className="text-[13px] font-medium text-fg">
      {label}{required && <span aria-hidden className="ml-0.5 text-danger">*</span>}
    </label>
  );
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error), required }}>
      <div className={cx('flex flex-col gap-1.5', className)}>
        {inline ? (
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              {labelNode}
              {description && <p id={descriptionId} className="text-xs text-fg-subtle">{description}</p>}
            </div>
            {children}
          </div>
        ) : (
          <>
            {labelNode}
            {children}
            {description && <p id={descriptionId} className="text-xs text-fg-subtle">{description}</p>}
          </>
        )}
        {error && <p id={errorId} className="text-xs font-medium text-danger">{error}</p>}
      </div>
    </FieldContext.Provider>
  );
}

/** Field wiring for custom controls. */
export function useFieldControl(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: AriaAttributes['aria-invalid']; required?: boolean }) {
  const field = useContext(FieldContext);
  const describedBy = [field?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return {
    id: props.id ?? field?.id,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid ? true : undefined),
    required: props.required ?? (field?.required || undefined)
  };
}

const CONTROL = 'w-full min-w-0 rounded-md bg-raised text-[13px] text-fg shadow-[inset_0_0_0_1px_var(--color-line)] outline-none '
  + 'placeholder:text-fg-subtle transition-shadow duration-150 hover:shadow-[inset_0_0_0_1px_var(--color-line-strong)] '
  + 'focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent),0_0_0_3px_var(--color-accent-ring)] focus-visible:outline-none '
  + 'aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)] disabled:cursor-not-allowed disabled:opacity-55';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> };

export function Input({ className, ...props }: InputProps) {
  const wiring = useFieldControl(props);
  return <input {...props} {...wiring} className={cx(CONTROL, 'h-8 px-2.5', className)} />;
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> };

export function Textarea({ className, ...props }: TextareaProps) {
  const wiring = useFieldControl(props);
  return <textarea {...props} {...wiring} className={cx(CONTROL, 'resize-y px-2.5 py-2 leading-normal', className)} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> };

export function Select({ className, children, ...props }: SelectProps) {
  const wiring = useFieldControl(props);
  return (
    <span className={cx('relative inline-flex w-full', className)}>
      <select {...props} {...wiring} className={cx(CONTROL, 'h-8 appearance-none pl-2.5 pr-8')}>{children}</select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name when the switch is not inside a Field. */
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

/** On/off switch (`role="switch"`); label it with a Field (inline) or aria-label. */
export function Switch({ checked, onCheckedChange, disabled, size = 'md', ...props }: SwitchProps) {
  const wiring = useFieldControl(props);
  const transition = useSafeTransition(springs.control);
  const dims = size === 'sm' ? { track: 'h-4 w-7', thumb: 'size-3', travel: 12 } : { track: 'h-5 w-9', thumb: 'size-4', travel: 16 };
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={props['aria-label']} disabled={disabled}
      id={wiring.id} aria-describedby={wiring['aria-describedby']} aria-invalid={wiring['aria-invalid']}
      onClick={() => onCheckedChange(!checked)}
      className={cx('relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-out-expo disabled:cursor-not-allowed disabled:opacity-45',
        dims.track, checked ? 'bg-accent' : 'bg-line-strong')}>
      <motion.span aria-hidden animate={{ x: checked ? dims.travel : 0 }} transition={transition} initial={false}
        className={cx('block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)]', dims.thumb)} />
    </button>
  );
}
