import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  hint?: string
}

/** App-style dropdown (replaces the native <select>): icon + label button, floating menu with icons. */
export default function Dropdown<T extends string>({
  value,
  options,
  onChange,
  align = 'left'
}: {
  value: T
  options: DropdownOption<T>[]
  onChange: (v: T) => void
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]
  const CurrentIcon = current.icon

  useEffect(() => {
    if (!open) return
    setFocus(Math.max(0, options.findIndex((o) => o.value === value)))
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (v: T) => {
    onChange(v)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return setOpen(true)
      const d = e.key === 'ArrowDown' ? 1 : -1
      setFocus((f) => (f + d + options.length) % options.length)
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault()
      pick(options[focus].value)
    }
  }

  return (
    <div className={`dropdown ${open ? 'open' : ''}`} ref={root} onKeyDown={onKey}>
      <button type="button" className="dropdown-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {CurrentIcon && <CurrentIcon size={15} className="dropdown-icon" aria-hidden />}
        <span>{current.label}</span>
        <ChevronDown size={15} className="dropdown-chevron" aria-hidden />
      </button>
      {open && (
        <ul className={`dropdown-menu ${align}`} role="listbox">
          {options.map((o, i) => {
            const Icon = o.icon
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`${o.value === value ? 'selected' : ''} ${i === focus ? 'focused' : ''}`}
                onMouseEnter={() => setFocus(i)}
                onClick={() => pick(o.value)}
              >
                {Icon && <Icon size={15} className="dropdown-icon" aria-hidden />}
                <span className="dropdown-label">
                  {o.label}
                  {o.hint && <span className="dropdown-hint">{o.hint}</span>}
                </span>
                {o.value === value && <Check size={14} className="dropdown-check" aria-hidden />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
