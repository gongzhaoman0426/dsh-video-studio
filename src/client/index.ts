import type { ComponentType } from 'react'
import type { SettingsDescribe, SettingsForm, SettingsPanelProps } from './contracts.ts'
import { SettingsPanel } from './settings-panel.tsx'
import { SETTINGS_NS } from './model.ts'

export const name = 'dsh-chapter-video-studio-settings'
export const inject = ['slots', 'configForms']

export interface SettingsClientContext {
  effect(effect: () => (() => void), label?: string): unknown
  configForms: {
    get(namespace: string): SettingsForm
    describe(): SettingsDescribe
    whileServed(namespaces: readonly string[], register: () => (() => void)): () => void
  }
  slots: {
    inject(name: string, register: () => (() => void)): () => void
    register(options: { name: string; id: string; order: number; label: string; inject: () => SettingsPanelProps }, component: ComponentType<SettingsPanelProps>): () => void
  }
}

/** The browser contributes only this native Settings → Plugins tab. */
export function apply(ctx: SettingsClientContext): void {
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab', id: SETTINGS_NS, order: 40, label: '视频工作室',
    inject: () => ({ form: ctx.configForms.get(SETTINGS_NS), describe: ctx.configForms.describe() }),
  }, SettingsPanel))), 'chapter-video: native model settings')
}
