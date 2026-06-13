import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Self-contained generate → preview → send email modal.
 *
 * Props:
 *   job    — { target_id, recruiter_email?, recruiter_name?, title? }
 *   onClose() — called to dismiss the modal
 *   onSent()  — called after a successful send (parent updates tracker UI)
 *
 * On mount it immediately calls /generate-email, then shows an editable
 * preview. The recruiter only ever receives the email after an explicit
 * Send click.
 */
export default function EmailComposer({ job, onClose, onSent }) {
  const [email, setEmail] = useState({
    status: 'generating', subject: '', body: '', toEmail: '', modelUsed: '', error: '', missingFields: [],
  })
  const bodyRef = useRef(null)

  const generate = useCallback(async () => {
    setEmail(e => ({ ...e, status: 'generating', error: '' }))
    try {
      const r = await fetch(`/api/jobs/${job.target_id}/generate-email`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Generation failed')
      setEmail({
        status: 'ready', subject: d.subject, body: d.body, toEmail: d.to_email,
        modelUsed: d.model_used || '', error: '', missingFields: d.missing_fields || [],
      })
    } catch (e) {
      setEmail(prev => ({ ...prev, status: 'error', error: e.message }))
    }
  }, [job.target_id])

  useEffect(() => { generate() }, [generate])

  // Esc closes (except mid-send)
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape' && email.status !== 'sending') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [email.status, onClose])

  async function send() {
    setEmail(prev => ({ ...prev, status: 'sending', error: '' }))
    try {
      const r = await fetch(`/api/jobs/${job.target_id}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: email.subject, body: email.body, to_email: email.toEmail, model_used: email.modelUsed }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Send failed')
      setEmail(prev => ({ ...prev, status: 'sent' }))
      onSent && onSent()
    } catch (e) {
      setEmail(prev => ({ ...prev, status: 'ready', error: e.message }))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onMouseDown={e => { if (e.target === e.currentTarget && email.status !== 'sending') onClose() }}>
      <div className="bg-[rgb(var(--bg))] border border-[rgb(var(--line))] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgb(var(--line))]">
          <div className="min-w-0">
            <h3 className="font-bold text-ink text-base truncate">{job.title || 'Send Email to Recruiter'}</h3>
            <p className="text-xs text-muted mt-0.5 truncate">
              To: {email.toEmail || job.recruiter_email || '—'}
            </p>
          </div>
          <button onClick={onClose} disabled={email.status === 'sending'}
            className="text-muted hover:text-ink transition-colors disabled:opacity-40">
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 custom-scrollbar">
          {email.status === 'generating' ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <p className="text-muted text-sm">Generating email from your resume + this post…</p>
            </div>
          ) : email.status === 'error' ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <span className="material-symbols-outlined text-[40px] text-danger">error</span>
              <p className="font-semibold text-ink">Couldn’t generate the email</p>
              <p className="text-muted text-sm">{email.error}</p>
              <button onClick={generate}
                className="mt-2 bg-accent text-accent-ink px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide hover:brightness-110 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">refresh</span>Retry
              </button>
            </div>
          ) : email.status === 'sent' ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <span className="material-symbols-outlined text-[48px] text-success">check_circle</span>
              <p className="font-semibold text-ink text-lg">Email sent!</p>
              <p className="text-muted text-sm">Tracker status auto-updated to Applied.</p>
            </div>
          ) : (
            <>
              {email.error && (
                <div className="bg-danger/10 text-danger text-xs rounded-xl px-4 py-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">error</span>{email.error}
                </div>
              )}
              {(email.missingFields || []).length > 0 && (
                <div className="bg-warning/10 text-warning text-xs rounded-xl px-4 py-3 flex items-start gap-2">
                  <span className="material-symbols-outlined text-[16px] mt-0.5">info</span>
                  <span>Recruiter asked for fields missing from your profile — these were skipped: <b>{email.missingFields.join(', ')}</b></span>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-muted mb-1.5 uppercase tracking-wider">Subject</label>
                <input
                  type="text"
                  value={email.subject}
                  onChange={e => setEmail(p => ({ ...p, subject: e.target.value }))}
                  className="w-full rounded-xl border border-[rgb(var(--line))] bg-[rgb(var(--surface))] text-ink text-sm px-4 py-2.5 focus:outline-none focus:border-accent transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted mb-1.5 uppercase tracking-wider">Body</label>
                <textarea
                  ref={bodyRef}
                  value={email.body}
                  onChange={e => setEmail(p => ({ ...p, body: e.target.value }))}
                  rows={14}
                  className="w-full rounded-xl border border-[rgb(var(--line))] bg-[rgb(var(--surface))] text-ink text-sm px-4 py-2.5 font-mono leading-relaxed focus:outline-none focus:border-accent transition-colors resize-none custom-scrollbar"
                />
              </div>
              {email.modelUsed && (
                <p className="text-[11px] text-faint">Generated by {email.modelUsed} · resume PDF attaches automatically</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {(email.status === 'ready' || email.status === 'sending') && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[rgb(var(--line))]">
            <button onClick={onClose} disabled={email.status === 'sending'}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-muted hover:text-ink border border-[rgb(var(--line))] transition-colors disabled:opacity-40">
              Cancel
            </button>
            <button onClick={generate} disabled={email.status === 'sending'}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-muted hover:text-accent border border-[rgb(var(--line))] transition-colors flex items-center gap-1.5 disabled:opacity-40">
              <span className="material-symbols-outlined text-[15px]">refresh</span>Regenerate
            </button>
            <button onClick={send}
              disabled={email.status === 'sending' || !email.subject || !email.body}
              className="bg-accent text-accent-ink px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-wide hover:brightness-110 flex items-center gap-2 disabled:opacity-60 disabled:cursor-wait shadow-lg shadow-accent/25">
              <span className="material-symbols-outlined text-[16px]">{email.status === 'sending' ? 'sync' : 'send'}</span>
              {email.status === 'sending' ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
