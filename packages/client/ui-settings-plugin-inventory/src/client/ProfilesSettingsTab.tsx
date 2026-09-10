import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ProfileCompositionEntry, ProfileInventorySnapshot, ProfilePluginRow } from '@deepseek-ai/dsh-api-remotes/client'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginInventorySettingsTab.module.css'

/** Registration-side Remote face used by the profiles tab. */
export interface ProfilesSettingsTabInjected {
  /** Read the current Host profile composition snapshot. */
  listProfiles: () => Promise<ProfileInventorySnapshot>
}

/** Full component props assembled by the Settings slot renderer. */
export type ProfilesSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<ProfilesSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ProfileInventorySnapshot }

/** One stored composition file rendered read-only; absent files show nothing. */
function CompositionFile({ title, body, bodyLabel }: {
  readonly title: string
  readonly body: string | undefined
  readonly bodyLabel: string
}): ReactNode {
  if (body === undefined) return null
  return (
    <div className={css.profileFile}>
      <dt>{title}</dt>
      <dd>
        <pre className={css.yamlBlock} aria-label={bodyLabel}>{body}</pre>
      </dd>
    </div>
  )
}

/** One flattened patch row: entry identity with its disablement tag. */
function PluginRow({ row, t }: { readonly row: ProfilePluginRow; readonly t: ProfilesSettingsTabProps['t'] }): ReactNode {
  const identity = row.name ?? row.id ?? '?'
  return (
    <li className={css.profilePluginRow}>
      <code className={css.entryValue}>{identity}</code>
      {row.name !== null && row.id !== null && row.id !== row.name ? <span className={css.profileRowId}>{row.id}</span> : null}
      <Tag tone={row.disabled ? 'neutral' : 'success'}>{row.disabled ? t('disabledTag') : t('enabledTag')}</Tag>
    </li>
  )
}

/** One expandable profile card: bundles summary, then the composition files. */
function ProfileCard({ profile, t, expanded, onToggle }: {
  readonly profile: ProfileCompositionEntry
  readonly t: ProfilesSettingsTabProps['t']
  readonly expanded: boolean
  readonly onToggle: () => void
}): ReactNode {
  const detailId = `profile-details-${encodeURIComponent(profile.name)}`
  return (
    <li className={css.card} data-profile={profile.name} data-open={expanded ? 'true' : undefined}>
      <button
        className={css.cardContent}
        type="button"
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={`${profile.name}, ${String(profile.bundles.length)} ${t('bundlesUnit')}`}
        onClick={onToggle}
      >
        <strong className={css.cardTitle} title={profile.path}>{profile.name}</strong>
        <span className={css.cardTrailing}>
          <span className={css.profileBundles}>{profile.bundles.map(bundle => bundle.replace(/^@deepseek-ai\//, '')).join(' + ')}</span>
          <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
        </span>
      </button>
      {expanded ? (
        <div className={css.cardDetails} id={detailId}>
          <dl className={css.details}>
            <div>
              <dt>{t('profilePath')}</dt>
              <dd><code className={css.entryValue}>{profile.path}</code></dd>
            </div>
            <div>
              <dt>{t('bundlesLabel')}</dt>
              <dd>
                <ul className={css.profileBundleList}>
                  {profile.bundles.map(bundle => <li key={bundle}><code>{bundle}</code></li>)}
                </ul>
              </dd>
            </div>
            {profile.pluginRows === undefined || profile.pluginRows.length === 0 ? null : (
              <div>
                <dt>{t('pluginRowsLabel')}</dt>
                <dd>
                  <ul className={css.profilePluginList}>
                    {profile.pluginRows.map((row, index) => (
                      <PluginRow key={`${row.id ?? 'anon'}:${String(index)}`} row={row} t={t} />
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            <CompositionFile title={t('cordisYmlLabel')} body={profile.cordisYml} bodyLabel={t('cordisYmlLabel')} />
            <CompositionFile title={t('patchYmlLabel')} body={profile.patchYml} bodyLabel={t('patchYmlLabel')} />
          </dl>
        </div>
      ) : null}
    </li>
  )
}

/** Render the read-only profile composition inventory. */
export function ProfilesSettingsTab({ listProfiles, t }: ProfilesSettingsTabProps): ReactNode {
  const sectionId = useId()
  const [request, setRequest] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listProfiles()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [listProfiles, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }
  const toggle = (name: string): void => {
    setExpanded(current => current === name ? null : name)
  }

  return (
    <div className={css.section} id={`${sectionId}-profiles`} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        state.snapshot.profiles.length === 0
          ? <p className={css.status}>{t('profilesEmpty')}</p>
          : (
            <ul className={css.cards}>
              {state.snapshot.profiles.map(profile => (
                <ProfileCard
                  key={profile.name}
                  profile={profile}
                  t={t}
                  expanded={expanded === profile.name}
                  onToggle={() => { toggle(profile.name) }}
                />
              ))}
            </ul>
          )
      ) : null}
    </div>
  )
}
