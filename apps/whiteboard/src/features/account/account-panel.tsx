import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { Crown, X } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { cloudCall, type AccountUsage, type CloudLimit } from './cloud-api'

const AccountContext = createContext<{ openPlans: () => void; account?: AccountUsage } | null>(null)
const formatBytes = (value: number) =>
  value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState<CloudLimit | null>(null)
  const [requestStatus, setRequestStatus] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [requested, setRequested] = useState(false)
  const query = useQuery({
    queryKey: ['account-usage', user?.uid],
    queryFn: () => cloudCall<AccountUsage>('getAccountUsage', {}),
    enabled: Boolean(user && !user.isAnonymous),
    staleTime: 30000,
    retry: 1,
  })
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['account-usage'] })
  }, [queryClient])
  useEffect(() => {
    const onLimit = (event: Event) => {
      setLimit((event as CustomEvent<CloudLimit>).detail)
      refresh()
    }
    window.addEventListener('cloud-limit', onLimit)
    window.addEventListener('account-usage-changed', refresh)
    return () => {
      window.removeEventListener('cloud-limit', onLimit)
      window.removeEventListener('account-usage-changed', refresh)
    }
  }, [refresh])
  useEffect(() => {
    setLimit(null)
    setRequestStatus('')
    setRequested(false)
  }, [user?.uid])
  useEffect(() => {
    if (query.data?.plan === 'pro') {
      setLimit((current) => (['documentBytes', 'elementBytes'].includes(current?.metric ?? '') ? current : null))
    }
  }, [query.data?.plan])
  const account = query.data
  const pro = account?.plan === 'pro'
  const warnings = account
    ? [
        { label: 'Cloud boards', used: account.usage.boards, max: account.limits.boards },
        { label: 'Cloud image storage', used: account.usage.assetBytes, max: account.limits.assetBytes },
        { label: 'Cloud saves today', used: account.usage.saves, max: account.limits.dailySaves },
        {
          label: 'Cloud document storage',
          used: account.usage.currentDocumentBytes,
          max: account.limits.currentDocumentBytes,
        },
      ].filter(
        (metric) =>
          metric.max !== null &&
          metric.used >= (metric.label === 'Cloud boards' && metric.max === 3 ? 2 : metric.max * 0.8),
      )
    : []
  const critical = warnings.some((metric) => metric.max !== null && metric.used >= metric.max * 0.95)
  const openPlans = useCallback(() => {
    setOpen(true)
    refresh()
  }, [refresh])
  async function requestAccess() {
    setRequesting(true)
    try {
      await cloudCall('requestProAccess', {})
      setRequested(true)
      setRequestStatus('Request recorded. Pro access is granted manually; you have not been charged.')
    } catch (error) {
      setRequestStatus(error instanceof Error ? error.message : 'Could not record your request.')
    } finally {
      setRequesting(false)
    }
  }
  return (
    <AccountContext.Provider value={{ openPlans, account }}>
      {children}
      {limit ? (
        <div className="cloud-quota-banner" role="alert">
          <span>{limit.message}</span>
          <button type="button" onClick={openPlans}>
            {pro || ['documentBytes', 'elementBytes'].includes(limit.metric ?? '')
              ? 'View cloud limits'
              : 'View Pro and usage'}
          </button>
          <button type="button" aria-label="Dismiss cloud limit message" onClick={() => setLimit(null)}>
            <X size={16} />
          </button>
        </div>
      ) : !pro && warnings.length ? (
        <UsageWarning
          warnings={warnings.map((item) => item.label)}
          critical={critical}
          openPlans={openPlans}
          userId={user?.uid ?? ''}
          period={account?.resetsAt ?? ''}
        />
      ) : null}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="account-overlay" />
          <Dialog.Content className="account-dialog">
            <Dialog.Title>Plan and cloud usage</Dialog.Title>
            <Dialog.Description>
              Local editing, exports and local MCP remain free. Cloud allowances apply to boards you own, including
              guest activity.
            </Dialog.Description>
            <Dialog.Close className="account-close" aria-label="Close plan and usage">
              <X size={20} />
            </Dialog.Close>
            {query.isPending && user ? <p>Loading your cloud usage…</p> : null}
            {query.isError ? (
              <p role="alert">
                Could not load cloud usage.{' '}
                <button type="button" onClick={refresh}>
                  Try again
                </button>
              </p>
            ) : null}
            {account ? (
              <>
                <p className="account-current-plan">
                  {pro ? <Crown size={18} /> : null} {pro ? 'Pro' : 'Free'}
                  {account.source === 'complimentary' ? ' · Complimentary, no subscription required' : ''}
                </p>
                <UsageMeter label="Cloud boards" used={account.usage.boards} max={account.limits.boards} />
                <UsageMeter
                  label="Retained images"
                  used={account.usage.assetBytes}
                  max={account.limits.assetBytes}
                  bytes
                />
                <UsageMeter
                  label="Cloud document storage"
                  used={account.usage.currentDocumentBytes}
                  max={account.limits.currentDocumentBytes}
                  bytes
                />
                <UsageMeter label="Cloud saves today" used={account.usage.saves} max={account.limits.dailySaves} />
                <p className="account-note">
                  Daily saves reset {new Date(account.resetsAt).toLocaleString()}. Deleted images count until cloud
                  cleanup finishes.
                </p>
              </>
            ) : null}
            <div className="account-plan-grid">
              <section>
                <h3>Free</h3>
                <strong>$0</strong>
                <ul>
                  <li>3 cloud boards</li>
                  <li>25 MiB image storage</li>
                  <li>Images smaller than 5 MiB</li>
                  <li>3 live sessions per board</li>
                  <li>1,000 cloud saves per day</li>
                  <li>7-day recovery history</li>
                </ul>
              </section>
              <section className="account-pro-plan">
                <h3>
                  <Crown size={16} /> Pro
                </h3>
                <strong>
                  $6/month <small>or $60/year</small>
                </strong>
                <ul>
                  <li>Unlimited board count within storage allowances</li>
                  <li>1 GiB images + 100 MiB board documents</li>
                  <li>Images smaller than 10 MiB</li>
                  <li>10 live sessions per board</li>
                  <li>5,000 cloud saves per day</li>
                  <li>30-day recovery history, up to 50 snapshots per board</li>
                </ul>
              </section>
            </div>
            <p className="account-note">
              Payments are not available yet. Pro access is by invitation. Every plan has the same board-size safety
              limit; upgrading does not increase it.
            </p>
            {!pro && user ? (
              <button
                className="account-primary"
                type="button"
                disabled={requesting || !user.emailVerified || requested}
                onClick={() => void requestAccess()}
              >
                {requesting ? 'Recording request…' : 'Request Pro access'}
              </button>
            ) : null}
            {!pro && user && !user.emailVerified ? <p>Verify your email to request Pro access.</p> : null}
            {requestStatus ? <p role="status">{requestStatus}</p> : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AccountContext.Provider>
  )
}

function UsageWarning({
  warnings,
  critical,
  openPlans,
  userId,
  period,
}: {
  warnings: string[]
  critical: boolean
  openPlans: () => void
  userId: string
  period: string
}) {
  const key = `cloud-warning:${userId}:${period}:${warnings.join(',')}:${critical}`
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === 'dismissed' ? key : ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    const update = () => {
      try {
        setDismissed(localStorage.getItem(key) === 'dismissed' ? key : '')
      } catch {
        /* Storage may be unavailable. */
      }
    }
    update()
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [key])
  if (!critical && dismissed === key) return null
  return (
    <div className="cloud-quota-banner" role={critical ? 'alert' : 'status'}>
      <span>
        {warnings.join(', ')} {critical ? 'at or near capacity.' : 'approaching your allowance.'}
      </span>
      <button type="button" onClick={openPlans}>
        View usage and Pro
      </button>
      {!critical ? (
        <button
          type="button"
          onClick={() => {
            setDismissed(key)
            try {
              localStorage.setItem(key, 'dismissed')
            } catch {
              /* Storage may be unavailable. */
            }
          }}
          aria-label="Dismiss usage warning"
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  )
}
function UsageMeter({
  label,
  used,
  max,
  bytes = false,
}: {
  label: string
  used: number
  max: number | null
  bytes?: boolean
}) {
  const ratio = max === null ? 0 : Math.min(1, used / max)
  const value = (n: number) => (bytes ? formatBytes(n) : String(n))
  return (
    <div className="account-meter">
      <div>
        <span>{label}</span>
        <strong>
          {value(used)} / {max === null ? 'Unlimited count' : value(max)}
        </strong>
      </div>
      {max !== null ? (
        <progress aria-label={`${label}: ${value(used)} of ${value(max)}`} value={ratio} max={1} />
      ) : null}
    </div>
  )
}
export function useAccount() {
  const context = useContext(AccountContext)
  if (!context) throw new Error('AccountProvider is required')
  return context
}
export function PlanButton() {
  const { account, openPlans } = useAccount()
  return (
    <button type="button" className="account-plan-button" onClick={openPlans}>
      {account?.plan === 'pro' ? (
        <>
          <Crown size={14} /> Pro
        </>
      ) : account ? (
        'Upgrade to Pro'
      ) : (
        'Plan and usage'
      )}
    </button>
  )
}
