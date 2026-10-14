<template>
  <main class="mini-radio-shell" aria-label="迷你电台">
    <header class="radio-header">
      <span class="radio-brand">私人电台<span>RADIO</span></span>
      <div class="radio-window-controls">
        <button type="button" title="设置" aria-label="打开设置" @click="$emit('settings')">⚙</button>
        <button type="button" title="最小化" aria-label="最小化" @click="minWindow">−</button>
        <button type="button" title="关闭电台播放器" aria-label="关闭电台播放器" @click="quitApp">×</button>
      </div>
    </header>

    <section class="radio-display" aria-label="当前歌曲">
      <div class="radio-display-label"><span>正在收听</span><span>{{ isPlay ? '播放中' : musicInfo.id ? '已暂停' : '待开播' }}</span></div>
      <h1 :title="musicInfo.name">{{ musicInfo.name || '今晚，听点什么？' }}</h1>
      <p class="radio-singer" :title="musicInfo.singer">{{ musicInfo.singer || '在启动终端输入你想听的节目主题' }}</p>
      <div class="radio-tuner" role="progressbar" aria-label="歌曲播放进度" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
        <div class="radio-needle" :style="{ left: `${progress * 100}%` }" />
      </div>
      <div class="radio-time"><span>{{ playProgress.nowPlayTimeStr }}</span><span>播放进度</span><span>{{ playProgress.maxPlayTimeStr }}</span></div>
    </section>

    <div class="radio-play-controls">
      <button class="radio-play" type="button" :disabled="!musicInfo.id" :aria-label="isPlay ? '暂停' : '播放'" @click="togglePlay">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-if="isPlay" d="M7 5h4v14H7zM14 5h4v14h-4z" /><path v-else d="m8 4 13 8-13 8z" /></svg>
        {{ isPlay ? '暂停' : '播放' }}
      </button>
      <button class="radio-next" type="button" :disabled="!musicInfo.id" aria-label="下一首" @click="nextSong">
        下一首<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 10 7-10 7zM17 5h3v14h-3z" /></svg>
      </button>
    </div>

    <div class="radio-volume">
      <button type="button" :aria-label="isMute ? '取消静音' : '静音'" @click="setMute(!isMute)">{{ isMute ? '静音中' : '音量' }}</button>
      <input type="range" aria-label="音量" min="0" max="100" step="1" :value="Math.round(volume * 100)" @input="changeVolume">
      <output>{{ Math.round(volume * 100) }}</output>
    </div>

    <section class="radio-host" aria-label="主持人状态">
      <div class="radio-host-heading"><span class="radio-lamp" :class="{ active: host.phase === 'speaking' }" /><span>{{ hostLabel }}</span></div>
      <p :title="host.introduction || helperText">{{ host.introduction || helperText }}</p>
    </section>
    <footer class="radio-footer"><span>留一点时间给音乐</span><span v-if="status === 'error'" role="alert">播放失败，请试试下一首</span><span v-else>{{ host.enabled ? '主持人在线' : '等待主持人上线' }}</span></footer>
  </main>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from '@common/utils/vueTools'
import { musicInfo, isPlay, status } from '@renderer/store/player/state'
import { playProgress } from '@renderer/store/player/playProgress'
import { volume, isMute, setMute, setVolume } from '@renderer/store/player/volume'
import { togglePlay, playNext } from '@renderer/core/player'
import { minWindow, quitApp } from '@renderer/utils/ipc'
import { radioPlayback } from '@renderer/core/radio/playback'

defineEmits(['settings'])
const host = ref(radioPlayback.status())
const errorText = ref('')
const timer = setInterval(() => { host.value = radioPlayback.status() }, 250)
onBeforeUnmount(() => { clearInterval(timer) })
const progress = computed(() => Math.max(0, Math.min(1, playProgress.progress)))
const hostLabel = computed(() => {
  if (host.value.phase === 'paused') return '主持人口播已暂停'
  if (host.value.phase === 'speaking') return host.value.speechKind === 'intro' ? '主持人在介绍这首歌' : '主持人在说话'
  if (host.value.phase === 'ducking') return '主持人准备开口'
  if (host.value.phase === 'restoring') return '回到音乐时间'
  if (!host.value.enabled) return '主持人待命'
  return isPlay.value ? '音乐时间' : '电台已暂停'
})
const helperText = computed(() => {
  if (errorText.value) return errorText.value
  if (!host.value.enabled) return '打开电台启动脚本，让主持人陪你听歌。'
  if (host.value.preparedKeys.length) return '下一首的介绍已经准备好了。'
  if (host.value.scheduledInterjection) return '稍后，主持人会和你聊两句。'
  return '选歌和串词交给主持人，你只管听。'
})
const changeVolume = (event) => {
  setVolume(Number(event.target.value) / 100)
}
const nextSong = () => {
  errorText.value = ''
  void playNext().catch(() => { errorText.value = '暂时没能切换歌曲，请稍后再试。' })
}
</script>

<style lang="less" scoped>
.mini-radio-shell {
  --radio-body: #213b48;
  --radio-trim: #ced6cf;
  --radio-screen: #d9dfae;
  --radio-amber: #c48c3c;
  --radio-key: #e7e8df;
  --radio-ink: #192c34;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 18px 22px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  color: var(--radio-trim);
  background: var(--radio-body);
  font: 13px/1.45 'PingFang SC', 'Microsoft YaHei', sans-serif;
  button, input { -webkit-app-region: no-drag; }
  button { cursor: pointer; color: inherit; }
  button:disabled { cursor: default; opacity: .45; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--radio-amber); outline-offset: 4px; }
}
.radio-header { display: flex; align-items: center; justify-content: space-between; -webkit-app-region: drag; }
.radio-brand { font: 18px 'Songti SC', 'STSong', serif; letter-spacing: 2px; }
.radio-brand span { margin-left: 12px; font: 10px Menlo, monospace; letter-spacing: 2px; opacity: .65; }
.radio-window-controls { display: flex; gap: 8px; }
.radio-window-controls button { background: transparent; border: 0; width: 23px; height: 26px; padding: 0; font-size: 19px; opacity: .7; }
.radio-window-controls button:hover { opacity: 1; }
.radio-display { padding: 16px 17px 12px; color: var(--radio-ink); background: var(--radio-screen); border-radius: 5px; border: 3px solid var(--radio-ink); box-shadow: inset 0 2px 6px #192c342b; }
.radio-display-label { display: flex; justify-content: space-between; font-size: 10px; letter-spacing: 1px; opacity: .7; }
.radio-display h1 { font: 28px/1.3 'Songti SC', 'STSong', serif; margin: 12px 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.radio-singer { height: 19px; margin: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
.radio-tuner { position: relative; height: 19px; margin: 17px 2px 4px; border-bottom: 1px solid #192c3460; background: repeating-linear-gradient(90deg, #192c3450 0, #192c3450 1px, transparent 1px, transparent 10px); }
.radio-needle { position: absolute; top: -3px; height: 25px; width: 2px; background: var(--radio-ink); transform: translateX(-1px); }
.radio-time { display: flex; justify-content: space-between; font: 10px Menlo, monospace; }
.radio-time span:nth-child(2) { font-family: 'PingFang SC', sans-serif; opacity: .6; }
.radio-play-controls { display: flex; gap: 10px; height: 44px; flex-shrink: 0; }
.radio-play-controls button { display: flex; justify-content: center; align-items: center; gap: 10px; border: 1px solid #192c34; border-radius: 5px; font-size: 13px; box-shadow: 0 3px 0 #192c34; }
.radio-play-controls button:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 #192c34; }
.radio-play-controls svg { width: 18px; height: 18px; fill: currentColor; }
.radio-play { flex: 1.4; background: var(--radio-key); color: var(--radio-ink) !important; }
.radio-next { flex: 1; background: #ffffff0a; color: var(--radio-trim); }
.radio-volume { display: flex; align-items: center; gap: 12px; height: 20px; flex-shrink: 0; }
.radio-volume button { padding: 0; min-width: 40px; text-align: left; font-size: 11px; border: 0; background: none; }
.radio-volume input { min-width: 0; flex: 1; accent-color: var(--radio-trim); height: 3px; cursor: pointer; }
.radio-volume output { font: 10px Menlo, monospace; width: 24px; text-align: right; }
.radio-host { min-height: 48px; flex: 1; padding-top: 13px; border-top: 1px solid #ced6cf30; overflow: hidden; }
.radio-host-heading { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.radio-lamp { width: 6px; height: 6px; border-radius: 50%; background: #ced6cf50; }
.radio-lamp.active { background: var(--radio-amber); box-shadow: 0 0 6px #c48c3c60; }
.radio-host p { margin: 7px 0 0; font-size: 12px; opacity: .8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.radio-footer { display: flex; justify-content: space-between; gap: 8px; font-size: 10px; opacity: .55; flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) { .mini-radio-shell * { transition: none !important; } }
</style>
