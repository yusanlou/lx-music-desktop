<template>
  <section class="radio-chat" aria-label="与主持人聊天">
    <div class="chat-heading">
      <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? '收起聊天 −' : '和主持人聊聊 +' }}</button>
      <span>{{ connected ? '文字输入 · 语音回复' : '主持人未连接' }}</span>
    </div>
    <div v-if="expanded" ref="history" class="chat-history" role="log" aria-live="polite" aria-label="聊天记录">
      <p v-if="!messages.length" class="chat-welcome">聊聊这首歌，或者告诉我下一首想听什么。输入“来一期90年代华语电台”也能开播。</p>
      <article v-for="message in messages" :key="message.id" class="chat-turn">
        <p class="chat-user"><span>你</span>{{ message.text }}</p>
        <p v-if="message.reply" class="chat-reply"><span>主持人</span>{{ message.reply }}</p>
        <p v-if="message.actionResult?.requested" class="chat-action">已安排下一首：{{ message.actionResult.song.name }} · {{ message.actionResult.song.singer }}</p>
        <div v-if="message.status === 'queued' || message.status === 'processing'" class="chat-pending">
          <span>{{ message.stage }}</span><button type="button" @click="cancel(message.id)">取消</button>
        </div>
        <p v-else-if="message.status === 'cancelled'" class="chat-note">回答已取消</p>
        <div v-if="message.voiceStatus" class="chat-pending">
          <span>{{ message.voiceDetail }}</span><button v-if="voicePending(message)" type="button" @click="cancel(message.id)">停止语音</button>
        </div>
        <p v-if="message.song?.name && message.kind === 'dialogue'" class="chat-song">聊的是《{{ message.song.name }}》</p>
      </article>
    </div>
    <form class="chat-composer" @submit.prevent="send">
      <textarea v-model="draft" rows="2" maxlength="1000" aria-label="聊天或点歌消息" :placeholder="kind === 'programme' ? '这一期想听什么？' : '聊聊、点歌，Enter 发送'" @keydown="inputKey" @compositionstart="composing = true" @compositionend="composing = false" />
      <div class="chat-actions">
        <select v-model="kind" aria-label="消息用途"><option value="auto">聊天 / 点歌</option><option value="programme">开新节目</option></select>
        <button type="button" :disabled="!connected" @click="control(paused ? '/play' : '/pause')">{{ paused ? '继续' : '暂停' }}</button>
        <button type="button" :disabled="!connected" @click="control('/next')">下一首</button>
        <button class="chat-send" type="submit" :disabled="!connected || !draft.trim() || sending">{{ sending ? '发送中' : '发送' }}</button>
      </div>
    </form>
    <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from '@common/utils/vueTools'
import { getRadioConversation, sendRadioMessage, cancelRadioMessage } from '@renderer/core/radio/conversation'

const props = defineProps({ paused: Boolean, song: { type: Object, default: () => ({}) } })
const emit = defineEmits(['expand'])
const draft = ref('')
const kind = ref('auto')
const messages = ref([])
const expanded = ref(false)
const connected = ref(false)
const sending = ref(false)
const error = ref('')
const history = ref(null)
let revision = -1
let instance
let timer
let disposed = false
let composing = false
let retryRequest
watch(expanded, value => { emit('expand', value) })
const scroll = async() => { await nextTick(); if (history.value) history.value.scrollTop = history.value.scrollHeight }
const applyState = (result) => {
  connected.value = !!(result.ok && result.ready)
  if (result.ok && instance !== result.instance) { instance = result.instance; revision = -1 }
  if (result.ok && !result.unchanged && result.revision >= revision) {
    const nearBottom = !history.value || history.value.scrollHeight - history.value.scrollTop - history.value.clientHeight < 50
    messages.value = result.messages
    revision = result.revision
    if (nearBottom) void scroll()
  }
}
const rememberRetry = (request) => { retryRequest = request }
const voicePending = message => ['queued', 'generating', 'waiting', 'speaking'].includes(message.voiceStatus)
const poll = async() => {
  try {
    const result = await getRadioConversation(revision)
    if (disposed) return
    applyState(result)
  } catch {
    if (!disposed) connected.value = false
  } finally {
    if (!disposed) timer = setTimeout(poll, 800)
  }
}
const send = async() => {
  if (composing || sending.value || !connected.value || !draft.value.trim()) return
  const text = draft.value.trim()
  const song = props.song?.id ? { id: props.song.id, name: props.song.name, singer: props.song.singer, source: props.song.source } : undefined
  const request = retryRequest?.text === text && retryRequest.kind === kind.value ? retryRequest : { id: crypto.randomUUID(), text, kind: kind.value, song }
  sending.value = true
  error.value = ''
  try {
    const result = await sendRadioMessage(request)
    if (!result.ok) throw new Error(result.error || '消息未发送，请重试。')
    if (!messages.value.some(message => message.id === result.message.id)) messages.value.push(result.message)
    if (draft.value.trim() === text) draft.value = ''
    rememberRetry(undefined)
    expanded.value = true
    void scroll()
  } catch (failure) {
    rememberRetry(request)
    error.value = failure.message || '消息未发送，请重试。'
  } finally { sending.value = false }
}
const inputKey = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) {
    event.preventDefault()
    void send()
  }
}
const control = async(text) => {
  try {
    const label = { '/next': '下一首', '/pause': '暂停', '/play': '继续播放' }[text] || text
    const result = await sendRadioMessage({ id: crypto.randomUUID(), text: label, kind: 'control' })
    if (!result.ok) throw new Error(result.error)
  } catch (failure) { error.value = failure.message || '控制未执行，请重试。' }
}
const cancel = async(id) => {
  try {
    const result = await cancelRadioMessage(id)
    if (!result.ok) throw new Error(result.error)
    if (result.cancelled) {
      for (const message of messages.value) {
        if (message.id !== id) continue
        if (message.status === 'completed') { message.voiceStatus = 'cancelled'; message.voiceDetail = '语音已停止' } else message.status = 'cancelled'
      }
    }
  } catch (failure) { error.value = failure.message || '取消未完成，请重试。' }
}
onMounted(poll)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>

<style lang="less" scoped>
.radio-chat { flex-shrink: 0; border-top: 1px solid #ced6cf30; padding-top: 10px; font-size: 11px; }
.chat-heading, .chat-actions, .chat-pending { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.chat-heading { margin-bottom: 8px; }.chat-heading button { padding: 0; border: 0; background: none; color: inherit; }.chat-heading>span { opacity: .6; font-size: 10px; }
.chat-history { height: 175px; overflow-y: auto; margin-bottom: 9px; padding: 0 5px; user-select: text; }
.chat-turn { border-bottom: 1px solid #ced6cf18; padding: 8px 0; }.chat-turn p { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }.chat-turn p span { display: block; font-size: 10px; opacity: .5; margin-bottom: 3px; }.chat-user { opacity: .7; }.chat-reply { color: #e7e8df; }.chat-note, .chat-song { font-size: 10px; opacity: .5; }.chat-action { color: #d9dfae; }.chat-welcome { line-height: 1.8; opacity: .6; }
.chat-composer textarea { box-sizing: border-box; width: 100%; resize: none; padding: 8px 10px; border: 1px solid #ced6cf50; border-radius: 4px; background: #192c34; color: #e7e8df; font: inherit; line-height: 1.5; user-select: text; }.chat-composer textarea:focus { border-color: #c48c3c; outline: none; }
.chat-actions { margin-top: 6px; }.chat-actions select { max-width: 108px; font: inherit; border: 0; color: inherit; background: #213b48; }.chat-actions button, .chat-pending button { font: inherit; padding: 5px 7px; border: 1px solid #ced6cf40; border-radius: 3px; background: none; color: inherit; cursor: pointer; }.chat-actions .chat-send { background: #d9dfae; border-color: #d9dfae; color: #192c34; }.chat-actions button:disabled { opacity: .4; cursor: default; }.chat-pending { color: #d9dfae; font-size: 10px; }.chat-error { color: #eac6a0; margin: 6px 0 0; line-height: 1.5; }
button, select, textarea { -webkit-app-region: no-drag; }button:focus-visible, select:focus-visible { outline: 2px solid #c48c3c; outline-offset: 2px; }
</style>
