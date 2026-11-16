import { useState } from 'react'

/** A console line with a copy button. */
export default function CopyLine({ text, hidden }: { text: string; hidden?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="copy-line">
      <code>{hidden ? text.replace(hidden, '•'.repeat(8)) : text}</code>
      <button className="small-btn" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
