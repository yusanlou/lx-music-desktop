/** Owns prepared speech, song-relative cues and transient music gain. */
export const songKey = (song: { id: string, source: string }) => `${song.source}:${song.id}`

export interface MusicCue {
  afterText: string
  // Older clients may send these; opening speech never ducks music.
  volume?: number
  fadeInSeconds?: number
  restoreSeconds?: number
}
export interface InterjectionPlan {
  atSeconds: number
  volume: number
  fadeDownSeconds: number
  restoreSeconds: number
}
interface Speech {
  key: string
  text: string
  audio: HTMLAudioElement | null
  kind: 'intro' | 'interjection' | 'progress'
  cueFraction: number
  plan?: InterjectionPlan
  started: boolean
}

export class RadioPlayback {
  enabled = false
  sessionId = 0
  positionId = 0
  musicStarted = false
  musicGain = 1
  private readonly prepared = new Map<string, Speech>()
  private readonly rejectedMusic = new Map<string, string>()
  private active: Speech | null = null
  private pendingInterjection: Speech | null = null
  private interjectionDecided = false
  private interjectionResult = ''
  private interjectionReason = ''
  private interjectionCount = 0
  private lastInterjectionProgress: number | null = null
  private songProgress = 0
  private songDuration = 0
  private readonly recentSpeech: Array<{ kind: string, key: string, text: string }> = []
  private interjectionRequest = 0
  private continueSong: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  private failed = false
  private voiceVolume = 1
  private voiceGain = 1
  private interjectionMusicGain = 1
  private interjectionVoiceGain = 1
  private regularInterjections = 1
  private longInterjections = 2
  private longSongSeconds = 240
  private minGapSeconds = 45
  private voiceMuted = false
  private gainHandler: ((gain: number) => void) | null = null
  private fadeTimer: ReturnType<typeof setInterval> | null = null
  private fadeTickAt = 0
  private lastProgressSpeechAt = -Infinity

  constructor(private readonly createAudio: (url: string) => HTMLAudioElement, private readonly now: () => number = () => performance.now()) {}

  configure(enabled: boolean, voiceGain?: number, interjectionMusicGain?: number, interjectionVoiceGain?: number) {
    const continueSong = this.continueSong
    const wasPaused = this.paused
    this.cancel()
    for (const speech of this.prepared.values()) this.dispose(speech)
    this.prepared.clear()
    this.rejectedMusic.clear()
    this.enabled = enabled
    if (voiceGain !== undefined && Number.isFinite(voiceGain)) this.voiceGain = Math.max(0.5, Math.min(3, voiceGain))
    if (interjectionMusicGain !== undefined && Number.isFinite(interjectionMusicGain)) this.interjectionMusicGain = Math.max(0.5, Math.min(2, interjectionMusicGain))
    if (interjectionVoiceGain !== undefined && Number.isFinite(interjectionVoiceGain)) this.interjectionVoiceGain = Math.max(0.5, Math.min(1, interjectionVoiceGain))
    this.sessionId++
    this.interjectionDecided = false
    this.interjectionResult = ''
    this.interjectionReason = ''
    this.interjectionCount = 0
    this.lastInterjectionProgress = null
    if (!enabled && !wasPaused) continueSong?.()
    return this.sessionId
  }

  /** Apply controls without cancelling speech, prefetch, the queue or its anchor. */
  updateSettings(settings: Record<string, any>) {
    const number = (key: string, low: number, high: number, apply: (value: number) => void) => {
      const value = settings[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high) apply(value)
    }
    number('speech.voice_gain', 0.5, 3, value => { this.voiceGain = value })
    number('radio.interjection_voice_gain', 0.5, 1, value => { this.interjectionVoiceGain = value })
    number('radio.interjection_music_gain', 0.5, 2, value => { this.interjectionMusicGain = value })
    number('host.regular_interjections', 0, 4, value => { this.regularInterjections = Math.floor(value) })
    number('host.long_interjections', 0, 6, value => { this.longInterjections = Math.floor(value) })
    number('host.long_song_seconds', 120, 600, value => { this.longSongSeconds = value })
    number('host.min_gap_seconds', 15, 120, value => { this.minGapSeconds = value })
    const limit = this.songDuration >= this.longSongSeconds ? this.longInterjections : this.regularInterjections
    if (this.pendingInterjection && (this.interjectionCount >= limit ||
      (this.lastInterjectionProgress !== null && this.pendingInterjection.plan!.atSeconds < this.lastInterjectionProgress + this.minGapSeconds))) {
      this.dispose(this.pendingInterjection)
      this.pendingInterjection = null
      this.interjectionDecided = limit === 0
      this.interjectionResult = ''
    }
    for (const speech of this.prepared.values()) this.applyVoiceVolume(speech)
    if (this.active) this.applyVoiceVolume(this.active)
    if (this.pendingInterjection) this.applyVoiceVolume(this.pendingInterjection)
    if (this.active?.kind === 'interjection' && this.active.started) this.fadeTo(Math.min(0.5, this.active.plan!.volume * this.interjectionMusicGain), 0.3)
  }

  status() {
    const speaking = this.active
    const pending = this.pendingInterjection
    return {
      enabled: this.enabled,
      sessionId: this.sessionId,
      positionId: this.positionId,
      phase: (speaking ?? this.fadeTimer) ? (this.paused ? 'paused' : speaking ? (speaking.started ? 'speaking' : 'ducking') : 'restoring') : 'idle',
      speechKind: speaking?.kind ?? (this.fadeTimer ? 'interjection' : null),
      preparedKeys: [...this.prepared.keys()],
      rejectedMusic: [...this.rejectedMusic].map(([key, reason]) => ({ key, reason })),
      introduction: speaking?.text ?? '',
      musicStarted: this.musicStarted,
      musicGain: this.musicGain,
      introductionProgress: speaking?.audio?.currentTime ?? 0,
      introductionDuration: speaking?.audio?.duration ?? 0,
      musicCueAt: speaking?.kind === 'intro' && speaking.audio ? speaking.audio.duration * speaking.cueFraction : null,
      interjectionDecided: this.interjectionDecided,
      interjectionResult: this.interjectionResult,
      interjectionReason: this.interjectionReason,
      interjectionCount: this.interjectionCount,
      lastInterjectionProgress: this.lastInterjectionProgress,
      voiceGain: this.voiceGain,
      interjectionMusicGain: this.interjectionMusicGain,
      interjectionVoiceGain: this.interjectionVoiceGain,
      recentSpeech: [...this.recentSpeech],
      scheduledInterjection: pending?.plan ? { ...pending.plan, key: pending.key, text: pending.text } : null,
    }
  }

  async prepare(sessionId: number, key: string, text: string, audioUrl: string | undefined, isValid: () => boolean, cue?: MusicCue): Promise<boolean> {
    if (!this.enabled || sessionId !== this.sessionId || !isValid() || !text.length || this.isMusicRejected(key)) return false
    if (cue && !text.startsWith(cue.afterText)) return false
    // Without word alignment, map the selected text boundary to audio duration.
    const cueFraction = cue ? [...cue.afterText].length / [...text].length : 0
    const speech: Speech = { key, text, audio: audioUrl ? this.createAudio(audioUrl) : null, kind: 'intro', cueFraction, started: false }
    if (!await this.load(speech)) return false
    if (!this.enabled || sessionId !== this.sessionId || !isValid() || this.isMusicRejected(key)) {
      this.dispose(speech)
      return false
    }
    const old = this.prepared.get(key)
    if (old) this.dispose(old)
    this.prepared.set(key, speech)
    while (this.prepared.size > 3) {
      const oldestKey = this.prepared.keys().next().value!
      this.dispose(this.prepared.get(oldestKey)!)
      this.prepared.delete(oldestKey)
    }
    return true
  }

  forgetPrepared(key: string) {
    const speech = this.prepared.get(key)
    if (speech) this.dispose(speech)
    this.prepared.delete(key)
  }

  /** Optional diagnostic voice, separate from programme cues and their quotas. */
  async announceProgress(text: string, audioUrl: string) {
    const available = () => this.enabled && !this.paused && !this.active && !this.fadeTimer &&
      (!this.pendingInterjection?.plan || this.pendingInterjection.plan.atSeconds - this.songProgress > 8)
    if (!available() || this.now() - this.lastProgressSpeechAt < 60000) return { played: false, reason: 'busy_or_cooldown' }
    if (!text.trim() || text.length > 40) return { played: false, reason: 'invalid_text' }
    const sessionId = this.sessionId
    const positionId = this.positionId
    const speech: Speech = {
      key: 'progress',
      text,
      audio: this.createAudio(audioUrl),
      kind: 'progress',
      cueFraction: 0,
      started: false,
      plan: { atSeconds: 0, volume: 0.3, fadeDownSeconds: 0.2, restoreSeconds: 0.4 },
    }
    if (!await this.load(speech)) return { played: false, reason: 'audio_not_ready' }
    if (!available() || sessionId !== this.sessionId || positionId !== this.positionId ||
      !Number.isFinite(speech.audio!.duration) || speech.audio!.duration <= 0 || speech.audio!.duration > 6) {
      this.dispose(speech)
      return { played: false, reason: 'stale_or_too_long' }
    }
    this.lastProgressSpeechAt = this.now()
    this.active = speech
    this.bindCompletion(speech)
    this.fadeTo(0.3, 0.2, () => {
      if (this.active === speech && !this.paused) this.startVoice(speech)
    })
    return { played: true, audioSeconds: speech.audio!.duration }
  }

  private cancelProgressSpeech() {
    if (this.active?.kind !== 'progress') return
    const speech = this.active
    this.active = null
    this.clearTimer()
    this.clearFade()
    this.dispose(speech)
    this.setGain(1)
  }

  async planInterjection(sessionId: number, key: string, text: string, audioUrl: string | undefined,
    plan: InterjectionPlan | null, isValid: () => boolean, clock: () => { progress: number, duration: number }, reason = '') {
    if (!this.enabled || sessionId !== this.sessionId || !isValid()) return { prepared: false, reason: 'stale' }
    this.cancelProgressSpeech()
    if (this.active?.kind === 'interjection') return { prepared: false, reason: 'already_speaking' }
    const request = ++this.interjectionRequest
    if (!plan) {
      if (this.pendingInterjection) this.dispose(this.pendingInterjection)
      this.pendingInterjection = null
      this.interjectionDecided = true
      this.interjectionResult = 'declined'
      this.interjectionReason = reason
      return { prepared: false, reason: 'declined' }
    }
    if (!Number.isFinite(plan.atSeconds) || plan.atSeconds < 0 || !Number.isFinite(plan.volume) || plan.volume < 0 || plan.volume > 0.5 ||
      !Number.isFinite(plan.fadeDownSeconds) || plan.fadeDownSeconds < 0.1 || plan.fadeDownSeconds > 5 ||
      !Number.isFinite(plan.restoreSeconds) || plan.restoreSeconds < 0.1 || plan.restoreSeconds > 10) return { prepared: false, reason: 'invalid_plan' }
    const speech: Speech = { key, text, audio: audioUrl ? this.createAudio(audioUrl) : null, kind: 'interjection', cueFraction: 0, plan, started: false }
    if (!speech.audio || !await this.load(speech)) return { prepared: false, reason: 'audio_not_ready' }
    if (!this.enabled || sessionId !== this.sessionId || request !== this.interjectionRequest || !isValid()) {
      this.dispose(speech)
      return { prepared: false, reason: 'stale' }
    }
    const { progress, duration } = clock()
    const speechDuration = speech.audio.duration
    if (!Number.isFinite(duration) || !Number.isFinite(speechDuration) || speechDuration <= 0 ||
      plan.atSeconds - plan.fadeDownSeconds <= progress + 0.5 || plan.atSeconds + speechDuration + plan.restoreSeconds > duration - 0.5 ||
      (this.lastInterjectionProgress !== null && plan.atSeconds < this.lastInterjectionProgress + this.minGapSeconds) || this.interjectionCount >= (duration >= this.longSongSeconds ? this.longInterjections : this.regularInterjections)) {
      this.dispose(speech)
      return { prepared: false, reason: 'late_or_does_not_fit' }
    }
    if (this.pendingInterjection) this.dispose(this.pendingInterjection)
    this.pendingInterjection = speech
    this.interjectionDecided = true
    this.interjectionResult = 'prepared'
    this.interjectionReason = reason
    return { prepared: true, atSeconds: plan.atSeconds, audioSeconds: speechDuration }
  }

  /** Driven by actual music progress, not time elapsed since preparation. */
  updateSong(progress: number, duration: number, playing: boolean) {
    this.songProgress = progress
    this.songDuration = duration
    if (playing && Number.isFinite(duration) && duration > 0) this.musicStarted = true
    const pending = this.pendingInterjection
    if (pending?.plan && progress >= pending.plan.atSeconds - pending.plan.fadeDownSeconds - 0.5) this.cancelProgressSpeech()
    if (!this.enabled || !pending?.plan || !playing || this.paused || this.active !== null || this.fadeTimer !== null) return
    const plan = pending.plan
    if (progress > plan.atSeconds + 0.75 || plan.atSeconds + (pending.audio?.duration ?? 0) + plan.restoreSeconds > duration - 0.5) {
      this.pendingInterjection = null
      this.dispose(pending)
      this.interjectionResult = 'missed'
      return
    }
    if (progress < plan.atSeconds - plan.fadeDownSeconds) return
    this.pendingInterjection = null
    this.active = pending
    this.bindCompletion(pending)
    this.applyVoiceVolume(pending)
    this.interjectionResult = 'ducking'
    this.fadeTo(Math.min(0.5, plan.volume * this.interjectionMusicGain), plan.fadeDownSeconds, () => {
      if (this.active !== pending || this.paused) return
      this.interjectionResult = 'speaking'
      this.startVoice(pending)
    })
  }

  rejectMusic(key: string, reason: string) {
    this.rejectedMusic.set(key, reason)
    const speech = this.prepared.get(key)
    if (speech) this.dispose(speech)
    this.prepared.delete(key)
  }

  isMusicRejected(key: string) { return this.rejectedMusic.has(key) }

  beforeSong(key: string, continueSong: () => void): boolean {
    const wasPaused = this.paused
    this.cancel()
    this.paused = wasPaused
    if (!this.enabled) return false
    if (this.isMusicRejected(key)) return false
    const speech = this.prepared.get(key)
    if (!speech) return false
    this.prepared.delete(key)
    if (!speech.audio) return false
    this.active = speech
    this.continueSong = continueSong
    this.bindCompletion(speech)
    speech.audio.ontimeupdate = () => {
      if (this.active !== speech || this.paused || this.musicStarted || !Number.isFinite(speech.audio!.duration)) return
      if (speech.audio!.currentTime >= speech.audio!.duration * speech.cueFraction) this.startMusic()
    }
    if (!this.paused) {
      if (speech.cueFraction === 0) this.startMusic()
      this.startVoice(speech)
    }
    return true
  }

  pause(): boolean {
    this.cancelProgressSpeech()
    this.paused = true
    if (!this.active && !this.fadeTimer) return false
    this.active?.audio?.pause()
    this.clearTimer()
    return true
  }

  resume(): boolean {
    this.paused = false
    this.fadeTickAt = this.now()
    if (!this.active && !this.fadeTimer) return false
    const speech = this.active
    if (!speech) return true
    if (this.failed) queueMicrotask(() => { this.finish(speech, true) })
    else if (speech.started) this.startVoice(speech)
    else if (speech.kind === 'intro') {
      if (speech.cueFraction === 0) this.startMusic()
      this.startVoice(speech)
    }
    return true
  }

  setVolume(volume: number, mute: boolean) {
    this.voiceVolume = volume
    this.voiceMuted = mute
    if (this.active) this.applyVoiceVolume(this.active)
  }

  setMusicGainHandler(handler: (gain: number) => void) {
    this.gainHandler = handler
    handler(this.musicGain)
    return () => { if (this.gainHandler === handler) this.gainHandler = null }
  }

  get allowsMusic() { return !this.active || this.musicStarted }
  get isPaused() { return this.paused }

  songChanged() {
    this.positionId++
    this.cancel()
    this.interjectionDecided = false
    this.interjectionResult = ''
    this.interjectionReason = ''
    this.interjectionCount = 0
    this.lastInterjectionProgress = null
    this.songProgress = 0
  }

  cancel() {
    this.clearTimer()
    this.clearFade()
    this.interjectionRequest++
    const active = this.active
    this.active = null
    this.continueSong = null
    this.paused = false
    this.failed = false
    this.musicStarted = false
    this.setGain(1)
    if (active) this.dispose(active)
    if (this.pendingInterjection) this.dispose(this.pendingInterjection)
    this.pendingInterjection = null
  }

  private bindCompletion(speech: Speech) {
    speech.audio!.onended = () => { this.finish(speech) }
    speech.audio!.onerror = () => { this.finish(speech, true) }
  }

  private startVoice(speech: Speech) {
    if (!speech.started && speech.kind !== 'progress') {
      this.recentSpeech.push({ kind: speech.kind, key: speech.key, text: speech.text })
      if (this.recentSpeech.length > 8) this.recentSpeech.shift()
    }
    speech.started = true
    this.applyVoiceVolume(speech)
    this.armTimeout(speech)
    void speech.audio?.play().catch(() => { this.finish(speech, true) })
  }

  private applyVoiceVolume(speech: Speech) {
    if (!speech.audio) return
    speech.audio.volume = Math.min(1, this.voiceVolume * this.voiceGain) * (speech.kind === 'interjection' ? this.interjectionVoiceGain : 1)
    speech.audio.muted = this.voiceMuted
  }

  private finish(speech: Speech, failed = false) {
    if (this.active !== speech) return
    if (this.paused) {
      this.failed = true
      this.clearTimer()
      this.dispose(speech)
      return
    }
    this.clearTimer()
    this.active = null
    this.dispose(speech)
    if (speech.kind === 'interjection') {
      this.interjectionResult = failed ? 'audio_failed' : 'completed'
      if (failed) this.interjectionDecided = false
      else {
        this.interjectionCount++
        this.lastInterjectionProgress = this.songProgress
      }
      this.fadeTo(1, speech.plan!.restoreSeconds)
    } else if (speech.kind === 'progress') this.fadeTo(1, speech.plan!.restoreSeconds)
    else if (!this.musicStarted) this.startMusic()
  }

  private startMusic() {
    if (this.musicStarted) return
    this.musicStarted = true
    this.setGain(1)
    const continueSong = this.continueSong
    this.continueSong = null
    continueSong?.()
  }

  private async load(speech: Speech) {
    if (!speech.audio) return true
    const audio = speech.audio
    const ready = await new Promise<boolean>(resolve => {
      const finish = (ready: boolean) => {
        clearTimeout(timer)
        audio.oncanplay = null
        audio.onerror = null
        resolve(ready)
      }
      const timer = setTimeout(() => { finish(false) }, 5000)
      audio.oncanplay = () => { finish(true) }
      audio.onerror = () => { finish(false) }
      audio.preload = 'auto'
      audio.load()
    })
    if (!ready) this.dispose(speech)
    return ready
  }

  private setGain(gain: number) {
    this.musicGain = Math.max(0, Math.min(1, gain))
    this.gainHandler?.(this.musicGain)
  }

  private fadeTo(target: number, seconds: number, complete?: () => void) {
    this.clearFade()
    const start = this.musicGain
    let elapsed = 0
    this.fadeTickAt = this.now()
    this.fadeTimer = setInterval(() => {
      const now = this.now()
      const delta = Math.max(0, (now - this.fadeTickAt) / 1000)
      this.fadeTickAt = now
      if (this.paused) return
      elapsed += delta
      const fraction = Math.min(1, elapsed / seconds)
      this.setGain(fraction === 1 ? target : start + (target - start) * fraction)
      if (fraction === 1) {
        this.clearFade()
        complete?.()
      }
    }, 50)
  }

  private clearFade() {
    if (this.fadeTimer) clearInterval(this.fadeTimer)
    this.fadeTimer = null
  }

  private armTimeout(speech: Speech) {
    this.clearTimer()
    this.timer = setTimeout(() => { this.finish(speech, true) }, speech.kind === 'progress' ? 6500 : 90000)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private dispose(speech: Speech) {
    if (!speech.audio) return
    speech.audio.onended = null
    speech.audio.onerror = null
    speech.audio.ontimeupdate = null
    speech.audio.pause()
    speech.audio.removeAttribute('src')
    speech.audio.load()
  }
}

export const radioPlayback = new RadioPlayback(url => new Audio(url))
