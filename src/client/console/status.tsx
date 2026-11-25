/** Status tab: version, worker, enabled features and the computer-use runtime. */
import type { ReactNode } from 'react'
import type { ConsoleSnapshot } from '../../settings/console-contract.js'
import type { ConsoleT } from './locales.js'

const CU_STATE = { disabled: 'cuDisabled', unsupported: 'cuUnsupported', starting: 'cuStarting', ready: 'cuReady', failed: 'cuFailed' } as const

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

export function StatusTab({ snapshot, at, t }: { snapshot: ConsoleSnapshot; at: string | undefined; t: ConsoleT }) {
  const cu = snapshot.computerUse.status
  const enabled = snapshot.features.filter(feature => feature.enabled).map(feature => feature.id)
  const tone = (ok: boolean) => ok ? 'ops-console-dot ops-console-dot-ok' : 'ops-console-dot ops-console-dot-bad'
  return <div className="ops-console-stack">
    <div className="ops-status-card">
      <dl className="ops-facts">
        <Fact label={t('version')}>{snapshot.version}</Fact>
        <Fact label={t('platform')}>{snapshot.platform}</Fact>
        <Fact label={t('worker')}><span className={tone(snapshot.worker.available)} aria-hidden="true" />
          {snapshot.worker.available ? t('workerOk') : t('workerMissing')}
          {!snapshot.worker.available && snapshot.worker.detail && <span className="ops-console-detail">{snapshot.worker.detail}</span>}</Fact>
        <Fact label={t('features')}>{enabled.length ? enabled.join(', ') : t('featuresNone')}</Fact>
      </dl>
    </div>
    <div className="ops-status-card">
      <h3 className="ops-detail-title">{t('cu')}</h3>
      <dl className="ops-facts">
        <Fact label={t('cu')}><span className={tone(cu.state === 'ready')} aria-hidden="true" />{t(CU_STATE[cu.state])}</Fact>
        {cu.state !== 'disabled' && <Fact label={t('cuTools')}>{cu.tools.length}</Fact>}
        {cu.server && <Fact label={t('cuRestarts')}>{cu.server.starts}</Fact>}
      </dl>
      {cu.message && <p className="ops-note">{cu.message}</p>}
      {cu.server?.lastExit && <p className="ops-note">{cu.server.lastExit}</p>}
      {cu.conflict && <p role="alert" className="ops-field-error">{t('cuConflict')}</p>}
      {cu.backendMissing && <p role="alert" className="ops-field-error">{t('cuBackendMissing')}</p>}
    </div>
    {at && <p className="ops-note">{t('updatedAt')} {at}</p>}
  </div>
}
