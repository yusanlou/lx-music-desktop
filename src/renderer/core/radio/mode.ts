import { ref } from '@common/utils/vueTools'

export const isMiniRadioWindow = new URLSearchParams(window.location.search).get('radio') === 'mini'
export const isRadioStartup = new URLSearchParams(window.location.search).get('radioSession') === '1'
export const miniRadioMode = ref(isMiniRadioWindow)
export const miniRadioSize = { width: 390, height: 520 }
