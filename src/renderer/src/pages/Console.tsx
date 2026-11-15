import { useEffect, useRef, useState } from 'react'
import type { ServerStatus } from '@shared/ipc'

interface Props {
  status: ServerStatus
  log: string[]
  onClear: () => void
}

export default function Console({ status, log, onClear }: Props) {
  const [cmd, setCmd] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [replies, setReplies] = useState<string[]>([])
  const ref = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    if (stick.current) ref.current?.scrollTo(0, ref.current.scrollHeight)
  }, [log, replies])

  async function send() {
    const c = cmd.trim()
    if (!c) return
    setCmd('')
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50))
    try {
      const out = await window.api.server.exec(c)
      setReplies((r) => [...r, `] ${c}`, ...(out.trim() ? [out.trimEnd()] : [])])
    } catch (e) {
      setReplies((r) => [...r, `] ${c}`, `! ${(e as Error).message}`])
    }
  }

  return (
    <section className="console">
      <div className="console-head">
        <span className="muted small">Server log (csgo/console.log)</span>
        <button onClick={onClear}>Clear</button>
      </div>
      <pre
        className="log tall"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {log.join('\n')}
        {replies.length > 0 && '\n' + replies.join('\n')}
      </pre>
      <div className="row">
        <input
          list="cmd-history"
          placeholder={status.state === 'running' ? 'Console command (sent over RCON), e.g. meta list' : 'Start the server to send commands'}
          disabled={status.state !== 'running'}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <datalist id="cmd-history">
          {history.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        <button disabled={status.state !== 'running'} onClick={send}>
          Send
        </button>
      </div>
    </section>
  )
}
