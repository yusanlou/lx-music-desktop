<template>
  <section class="host-settings" role="dialog" ignore-tip aria-modal="true" aria-labelledby="host-settings-heading" @keydown.esc.stop.prevent="close" @keydown.tab="trapFocus">
    <header><div><span class="panel-label">RADIO · CONTROL</span><h1 id="host-settings-heading">主持人设置</h1></div><button ref="closeButton" type="button" aria-label="关闭主持人设置" @click="close">×</button></header>
    <p class="effect-note">音量立即试听，保存后保留。语速、人设和音色用于后续生成，已备好的口播保持原样。</p>
    <p v-if="loading" role="status">正在读取你的设置…</p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <div v-if="fields.length" class="settings-scroll">
      <details v-for="(items, group) in groups" :key="group" :open="group === '声音' || group === '插播与混音'">
        <summary>{{ group }}<span>{{ items.length }} 项</span></summary>
        <div v-for="field in items" :key="field.key" class="setting-row">
          <label :for="field.key">{{ field.label }}<output v-if="field.type === 'number'">{{ draft[field.key] }}</output><span v-if="field.live" class="live-label">即时</span></label>
          <select v-if="field.options" :id="field.key" v-model="draft[field.key]" :disabled="saving"><option v-for="option in field.options" :key="option" :value="option">{{ option }}</option></select>
          <input v-else-if="field.type === 'boolean'" :id="field.key" v-model="draft[field.key]" type="checkbox" :disabled="saving">
          <input v-else-if="field.type === 'number'" :id="field.key" v-model.number="draft[field.key]" type="range" :min="field.min" :max="field.max" :step="field.step" :disabled="saving" @input="preview(field, $event)">
          <textarea v-else-if="['host.persona', 'speech.ref_text', 'speech.instructions'].includes(field.key)" :id="field.key" v-model="draft[field.key]" rows="3" :disabled="saving" :maxlength="field.key === 'host.persona' ? 1000 : 4096" />
          <input v-else :id="field.key" v-model="draft[field.key]" type="text" :disabled="saving" :maxlength="field.key === 'host.name' ? 30 : 4096">
          <p v-if="field.help">{{ field.help }}</p>
        </div>
      </details>
      <button class="player-settings" type="button" @click="playerSettings">打开播放器设置 →</button>
    </div>
    <footer><p class="feedback" role="status">{{ message }}</p><div><button type="button" :disabled="loading || saving || !fields.length" @click="reset">恢复默认</button><button class="save" type="button" :disabled="loading || saving || !fields.length" @click="save">{{ saving ? '保存中…' : '保存设置' }}</button></div></footer>
  </section>
</template>
<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from '@common/utils/vueTools'
import { getHostSettings, saveHostSettings } from '@renderer/core/radio/hostSettings'
import { radioPlayback } from '@renderer/core/radio/playback'
const emit = defineEmits(['close', 'player-settings'])
const closeButton = ref(null)
let previousFocus
const fields = ref([])
const draft = ref({})
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const message = ref('')
let saved = {}
const groups = computed(() => fields.value.reduce((result, field) => { (result[field.group] ||= []).push(field); return result }, {}))
const preview = (field, event) => { if (field.live) radioPlayback.updateSettings({ [field.key]: Number(event.target.value) }); message.value = '更改尚未保存' }
const reset = () => { draft.value = Object.fromEntries(fields.value.map(field => [field.key, field.default])); radioPlayback.updateSettings(Object.fromEntries(fields.value.filter(field => field.live).map(field => [field.key, draft.value[field.key]]))); message.value = '已恢复默认预览，点击保存后保留。' }
const save = async() => {
  saving.value = true; error.value = ''; message.value = ''
  try {
    const result = await saveHostSettings(draft.value)
    if (!result.ok) throw new Error(result.error)
    saved = { ...result.values }; draft.value = { ...saved }; message.value = '已保存。生成类设置用于后续口播。'
  } catch (failure) { error.value = failure.message || '保存失败，请稍后重试。' } finally { saving.value = false }
}
const close = (event) => { if (!saving.value && !event?.isComposing) emit('close') }
const trapFocus = (event) => {
  const items = [...event.currentTarget.querySelectorAll('button, input, select, textarea, summary')].filter(element => !element.disabled && element.offsetParent !== null)
  const first = items[0]
  const last = items.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
const playerSettings = () => { if (!saving.value) emit('player-settings') }
onBeforeUnmount(() => { radioPlayback.updateSettings(saved); if (previousFocus?.isConnected) previousFocus.focus() })
onMounted(async() => {
  previousFocus = document.activeElement
  closeButton.value?.focus()
  try {
    const result = await getHostSettings()
    if (!result.ok) throw new Error(result.error)
    fields.value = result.fields; saved = { ...result.values }; draft.value = { ...saved }
  } catch (failure) { error.value = failure.message || '读取失败，请使用电台启动脚本重新打开。' } finally { loading.value = false }
})
</script>
<style lang="less" scoped>
.host-settings { position: absolute; inset: 0; z-index: 20; padding: 18px 22px 16px; box-sizing: border-box; background: #213b48; color: #ced6cf; display: flex; flex-direction: column; font: 12px/1.5 'PingFang SC', sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; -webkit-app-region: drag; }
h1 { font: 22px 'Songti SC', serif; margin: 3px 0; }.panel-label { font: 9px Menlo, monospace; letter-spacing: 2px; opacity: .65; }
button, input, select, textarea { -webkit-app-region: no-drag; font: inherit; }button { color: inherit; cursor: pointer; background: transparent; border: 1px solid #ced6cf60; border-radius: 4px; padding: 6px 10px; }button:disabled { opacity: .5; cursor: default; }header button { border: 0; font-size: 24px; padding: 0 5px; }
.effect-note { font-size: 11px; opacity: .75; margin: 10px 0; }.settings-scroll { min-height: 0; flex: 1; overflow-y: auto; padding-right: 7px; }
details { border-top: 1px solid #ced6cf35; }summary { padding: 10px 0; cursor: pointer; font-weight: 600; }summary span { float: right; opacity: .6; font-size: 10px; font-weight: 400; }
.setting-row { margin: 0 0 12px; }label { display: block; margin-bottom: 5px; }output { float: right; font-family: Menlo, monospace; color: #d9dfae; }.live-label { font-size: 9px; opacity: .6; margin-left: 7px; }
input[type=range] { width: 100%; accent-color: #d9dfae; }input[type=checkbox] { accent-color: #d9dfae; }input[type=text], select, textarea { box-sizing: border-box; width: 100%; color: #192c34; background: #e7e8df; border: 1px solid #192c34; border-radius: 4px; padding: 6px 8px; user-select: text; }textarea { resize: vertical; }.setting-row p { margin: 4px 0; font-size: 10px; opacity: .65; }
footer { flex-shrink: 0; border-top: 1px solid #ced6cf35; padding-top: 9px; }footer div { display: flex; gap: 10px; }footer button { flex: 1; }.save { background: #d9dfae; color: #192c34; border-color: #d9dfae; }.feedback { min-height: 14px; font-size: 11px; margin: 0 0 7px; }.error { color: #f5b09b; }.player-settings { margin: 5px 0 14px; font-size: 11px; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #c48c3c; outline-offset: 3px; }
</style>
