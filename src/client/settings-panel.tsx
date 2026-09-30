import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SettingsPanelProps } from './contracts.ts'
import { buildOperations, createEditor, saveEditor, secretIsSaved, type SettingsDraft, type SettingsEditor } from './model.ts'

const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid #8886', color: 'inherit', background: 'transparent', font: 'inherit' }
const buttonStyle: CSSProperties = { padding: '7px 12px', border: '1px solid #8886', borderRadius: 6, color: 'inherit', background: 'transparent', cursor: 'pointer', font: 'inherit' }
const muted: CSSProperties = { fontSize: 12, lineHeight: 1.6, opacity: .7, margin: '6px 0' }
const groupStyle: CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 16, margin: '16px 0', minWidth: 0 }

export function SettingsPanel({ form, describe }: SettingsPanelProps) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const descriptions = useSyncExternalStore(listener => describe.subscribe(listener), () => describe.getSnapshot())
  const [editor, setEditor] = useState<SettingsEditor | undefined>(() => createEditor(snapshot))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const prefix = useId()
  useEffect(() => { void describe.ensure().catch(() => {}) }, [describe])
  useEffect(() => { setEditor(current => current?.dirty ? current : createEditor(snapshot)) }, [snapshot])
  const readonly = !snapshot.writable || snapshot.mode !== 'host'
  const stale = editor !== undefined && snapshot.revision !== editor.revision
  const edit = (update: (draft: SettingsDraft) => void) => {
    setEditor(current => {
      if (!current) return current
      const draft = structuredClone(current.draft)
      update(draft)
      return { ...current, draft, dirty: true }
    })
    setMessage('')
  }
  const reload = () => { setEditor(createEditor(form.getSnapshot())); setMessage('已重新载入。未保存的修改已丢弃。') }
  const save = async () => {
    if (!editor || saving) return
    try { buildOperations(editor) } catch { setMessage('视频时长请填写 1–120 的整数，用逗号分隔。'); return }
    setSaving(true)
    setMessage('')
    try {
      const cleared = editor.draft.source === 'settings' && Object.values(editor.draft.secrets).some(secret => secret.clear)
      const result = await saveEditor(form, editor)
      if (result === 'refused') setMessage('保存未被接受，配置可能已更新或当前不可写。请重新载入后再修改。')
      else {
        setEditor(createEditor(form.getSnapshot()))
        setMessage(result === 'unchanged' ? '没有更改。' : cleared ? '设置已保存，选中的 API Key 已清空。' : '设置已保存，对后续生成任务生效。')
      }
    } catch { setMessage('保存失败，请检查配置格式和 DSH 连接后重试。') }
    finally { setSaving(false) }
  }
  const field = (label: string, value: string, change: (value: string) => void, placeholder?: string) => (
    <label style={{ display: 'block', margin: '12px 0' }}>{label}
      <input style={{ ...inputStyle, marginTop: 6 }} value={value} placeholder={placeholder} onChange={event => change(event.target.value)} autoComplete="off" spellCheck={false} />
    </label>
  )
  const secretField = (provider: 'ark' | 'tts') => {
    if (!editor) return null
    const secret = editor.draft.secrets[provider]
    const saved = secretIsSaved(descriptions, provider)
    const inputId = `${prefix}-${provider}-key`
    return <div style={{ margin: '12px 0' }}>
      <label htmlFor={inputId}>{provider === 'ark' ? 'Ark' : '配音'} API Key</label>
      <input id={inputId} type="password" style={{ ...inputStyle, marginTop: 6 }} value={secret.value} disabled={secret.clear}
        placeholder={secret.clear ? '保存后清空' : '输入新密钥；留空保留当前值'} autoComplete="new-password" spellCheck={false}
        onChange={event => edit(draft => { draft.secrets[provider] = { value: event.target.value, clear: false } })} />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 6 }}>
        <span style={muted}>{secret.clear ? '已标记清空，点击保存后生效。' : saved ? '已有保存值（不回显，保存值也可能为空）。' : '尚无保存值。'}</span>
        <button type="button" style={buttonStyle} onClick={() => edit(draft => { draft.secrets[provider] = { value: '', clear: !secret.clear } })}>{secret.clear ? '取消清空' : '清空此密钥'}</button>
      </div>
    </div>
  }
  if (snapshot.status === 'unavailable') return <p role="status">当前无法读取章节视频设置。请确认宿主已启用插件，并使用支持宿主设置的 DSH 连接。</p>
  if (!editor) return <p role="status">正在读取章节视频设置…</p>
  const draft = editor.draft
  return <section style={{ maxWidth: 720, lineHeight: 1.5 }} aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} style={{ fontSize: 18, margin: '0 0 8px' }}>视频工作室 · 模型设置</h2>
    <p style={muted}>配置图片、视频和配音服务。小说创作、分镜和生成仍在 DSH 会话中完成；文本模型沿用当前会话。</p>
    {readonly && <p role="status">当前连接只读，无法保存配置。</p>}
    {stale && <p role="status">宿主配置已发生变化。请重新载入后再编辑，避免覆盖其他修改。</p>}
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset disabled={readonly || saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label style={{ display: 'block', margin: '16px 0' }}>配置来源
          <select style={{ ...inputStyle, marginTop: 6 }} value={draft.source} onChange={event => edit(value => { value.source = event.target.value as SettingsDraft['source'] })}>
            <option value="settings">DSH 插件设置</option><option value="environment">宿主环境变量</option>
          </select>
        </label>
        {draft.source === 'environment' ? <p style={muted}>使用运行 DSH 的宿主环境中的 DSH_VIDEO_ARK_* 与 DSH_VIDEO_TTS_*。此模式不会读取下方设置的服务参数，也不会保存尚未提交的密钥编辑。切回“DSH 插件设置”可继续修改已保存的设置。</p> : <>
          <fieldset style={groupStyle}><legend>图片与视频 · 火山方舟 Ark</legend>
            {secretField('ark')}
            {field('图片模型 / 接入点 ID', draft.ark.imageModel, value => edit(next => { next.ark.imageModel = value }), '填写实际可用的模型 ID')}
            {field('视频模型 / 接入点 ID', draft.ark.videoModel, value => edit(next => { next.ark.videoModel = value }), '填写实际可用的模型 ID')}
            <details><summary style={{ cursor: 'pointer' }}>高级参数</summary>
              {field('API 根地址', draft.ark.baseUrl, value => edit(next => { next.ark.baseUrl = value }))}
              {field('支持的视频时长（秒）', draft.ark.videoDurations, value => edit(next => { next.ark.videoDurations = value }), '5, 10')}
              {field('图片尺寸（选填）', draft.ark.imageSize, value => edit(next => { next.ark.imageSize = value }), '留空跟随作品画幅')}
              <label style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={draft.ark.imageReferences} onChange={event => edit(next => { next.ark.imageReferences = event.target.checked })} /> 图片模型支持参考图输入</label>
              <label style={{ display: 'block', margin: '8px 0' }}><input type="checkbox" checked={draft.ark.videoReferences} onChange={event => edit(next => { next.ark.videoReferences = event.target.checked })} /> 视频模型支持首帧参考图</label>
              <p style={muted}>能力和时长需与实际模型一致。保存设置不会请求生成接口或验证模型能力。</p>
            </details>
          </fieldset>
          <fieldset style={groupStyle}><legend>配音 · OpenAI 兼容接口</legend>
            {secretField('tts')}
            {field('配音模型 ID', draft.tts.model, value => edit(next => { next.tts.model = value }))}
            {field('音色 ID', draft.tts.voice, value => edit(next => { next.tts.voice = value }))}
            <details><summary style={{ cursor: 'pointer' }}>高级参数</summary>
              {field('API 根地址', draft.tts.baseUrl, value => edit(next => { next.tts.baseUrl = value }))}
              <p style={muted}>服务需支持 /audio/speech；模型与音色填写该服务实际提供的 ID。</p>
            </details>
          </fieldset>
          <p style={muted}>密钥通过 DSH 原生设置保存到宿主当前配置，不回显，不写入作品或浏览器持久存储。留空保留原值；清空需点击“清空此密钥”后保存。</p>
        </>}
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="submit" style={buttonStyle} disabled={stale}>{saving ? '保存中…' : '保存设置'}</button>
          <button type="button" style={buttonStyle} onClick={reload}>重新载入</button>
        </div>
      </fieldset>
    </form>
    {message && <p role="status" style={{ marginTop: 12 }}>{message}</p>}
  </section>
}
